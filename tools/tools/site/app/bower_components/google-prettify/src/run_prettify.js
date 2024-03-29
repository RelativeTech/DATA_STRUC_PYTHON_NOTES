/**
 * @license
 * Copyright (C) 2013 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview
 * <div style="white-space: pre">
 * Looks at query parameters to decide which language handlers and style-sheets
 * to load.
 *
 * Query Parameter     Format           Effect                        Default
 * +------------------+---------------+------------------------------+--------+
 * | autorun=         | true | false  | If true then prettyPrint()   | "true" |
 * |                  |               | is called on page load.      |        |
 * +------------------+---------------+------------------------------+--------+
 * | lang=            | language name | Loads the language handler   | Can    |
 * |                  |               | named "lang-<NAME>.js".      | appear |
 * |                  |               | See available handlers at    | many   |
 * |                  |               | https://github.com/google/   | times. |
 * |                  |               | code-prettify/tree/master/   |        |
 * |                  |               | src                          |        |
 * +------------------+---------------+------------------------------+--------+
 * | skin=            | skin name     | Loads the skin stylesheet    | none.  |
 * |                  |               | named "<NAME>.css".          |        |
 * |                  |               | https://cdn.rawgit.com/      |        |
 * |                  |               | google/code-prettify/master/ |        |
 * |                  |               | styles/index.html            |        |
 * +------------------+---------------+------------------------------+--------+
 * | callback=        | JS identifier | When "prettyPrint" finishes  | none   |
 * |                  |               | window.exports[js_ident] is  |        |
 * |                  |               | called.                      |        |
 * |                  |               | The callback must be under   |        |
 * |                  |               | exports to reduce the risk   |        |
 * |                  |               | of XSS via query parameter   |        |
 * |                  |               | injection.                   |        |
 * +------------------+---------------+------------------------------+--------+
 *
 * Exmaples
 * .../run_prettify.js?lang=css&skin=sunburst
 *   1. Loads the CSS language handler which can be used to prettify CSS
 *      stylesheets, HTML <style> element bodies and style="..." attributes
 *      values.
 *   2. Loads the sunburst.css stylesheet instead of the default prettify.css
 *      stylesheet.
 *      A gallery of stylesheets is available at
 *      https://cdn.rawgit.com/google/code-prettify/master/styles/index.html
 *   3. Since autorun=false is not specified, calls prettyPrint() on page load.
 * </div>
 */

/**
 * @typedef {!Array.<number|string>}
 * Alternating indices and the decorations that should be inserted there.
 * The indices are monotonically increasing.
 */
let DecorationsT;

/**
 * @typedef {!{
 *   sourceNode: !Element,
 *   pre: !(number|boolean),
 *   langExtension: ?string,
 *   numberLines: ?(number|boolean),
 *   sourceCode: ?string,
 *   spans: ?(Array.<number|Node>),
 *   basePos: ?number,
 *   decorations: ?DecorationsT
 * }}
 * <dl>
 *  <dt>sourceNode<dd>the element containing the source
 *  <dt>sourceCode<dd>source as plain text
 *  <dt>pre<dd>truthy if white-space in text nodes
 *     should be considered significant.
 *  <dt>spans<dd> alternating span start indices into source
 *     and the text node or element (e.g. {@code <BR>}) corresponding to that
 *     span.
 *  <dt>decorations<dd>an array of style classes preceded
 *     by the position at which they start in job.sourceCode in order
 *  <dt>basePos<dd>integer position of this.sourceCode in the larger chunk of
 *     source.
 * </dl>
 */
let JobT;

/**
 * @typedef {!{
 *   sourceCode: string,
 *   spans: !(Array.<number|Node>)
 * }}
 * <dl>
 *  <dt>sourceCode<dd>source as plain text
 *  <dt>spans<dd> alternating span start indices into source
 *     and the text node or element (e.g. {@code <BR>}) corresponding to that
 *     span.
 * </dl>
 */
let SourceSpansT;

/** @define {boolean} */
const IN_GLOBAL_SCOPE = false;

(() => {
  'use strict';

  const win = window;
  const doc = document;
  const root = doc.documentElement;
  const head = doc['head'] || doc.getElementsByTagName('head')[0] || root;

  // From http://javascript.nwbox.com/ContentLoaded/contentloaded.js
  // Author: Diego Perini (diego.perini at gmail.com)
  // Summary: cross-browser wrapper for DOMContentLoaded
  // Updated: 20101020
  // License: MIT
  // Version: 1.2
  function contentLoaded(callback) {
    const addEventListener = doc['addEventListener'];
    let done = false;
    let top = true;
    const add = addEventListener ? 'addEventListener' : 'attachEvent';
    const rem = addEventListener ? 'removeEventListener' : 'detachEvent';
    const pre = addEventListener ? '' : 'on';

    const init = (e) => {
      if (e.type == 'readystatechange' && doc.readyState != 'complete') {
        return;
      }
      (e.type == 'load' ? win : doc)[rem](pre + e.type, init, false);
      if (!done && (done = true)) {
        callback.call(win, e.type || e);
      }
    };

    const poll = () => {
      try {
        root.doScroll('left');
      } catch (e) {
        win.setTimeout(poll, 50);
        return;
      }
      init('poll');
    };

    if (doc.readyState == 'complete') {
      callback.call(win, 'lazy');
    } else {
      if (doc.createEventObject && root.doScroll) {
        try {
          top = !win.frameElement;
        } catch (e) {}
        if (top) {
          poll();
        }
      }
      doc[add](pre + 'DOMContentLoaded', init, false);
      doc[add](pre + 'readystatechange', init, false);
      win[add](pre + 'load', init, false);
    }
  }

  // Given a list of URLs to stylesheets, loads the first that loads without
  // triggering an error event.
  function loadStylesheetsFallingBack(stylesheets) {
    const n = stylesheets.length;
    function load(i) {
      if (i === n) {
        return;
      }
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.type = 'text/css';
      if (i + 1 < n) {
        // http://pieisgood.org/test/script-link-events/ indicates that many
        // versions of IE do not support onerror on <link>s, though
        // http://msdn.microsoft.com/en-us/library/ie/ms535848(v=vs.85).aspx
        // indicates that recent IEs do support error.
        link.error = link.onerror = () => {
          load(i + 1);
        };
      }
      link.href = stylesheets[i];
      head.appendChild(link);
    }
    load(0);
  }

  let scriptQuery = '';
  // Look for the <script> node that loads this script to get its parameters.
  // This starts looking at the end instead of just considering the last
  // because deferred and async scripts run out of order.
  // If the script is loaded twice, then this will run in reverse order.
  const scripts = doc.getElementsByTagName('script');
  for (var i = scripts.length; --i >= 0; ) {
    const script = scripts[i];
    const match = script.src.match(
      /^[^?#]*\/run_prettify\.js(\?[^#]*)?(?:#.*)?$/
    );
    if (match) {
      scriptQuery = match[1] || '';
      // Remove the script from the DOM so that multiple runs at least run
      // multiple times even if parameter sets are interpreted in reverse
      // order.
      script.parentNode.removeChild(script);
      break;
    }
  }

  // Pull parameters into local variables.
  let autorun = true;
  const langs = [];
  const skins = [];
  const callbacks = [];
  scriptQuery.replace(/[?&]([^&=]+)=([^&]+)/g, (_, name, value) => {
    value = decodeURIComponent(value);
    name = decodeURIComponent(name);
    if (name == 'autorun') {
      autorun = !/^[0fn]/i.test(value);
    } else if (name == 'lang') {
      langs.push(value);
    } else if (name == 'skin') {
      skins.push(value);
    } else if (name == 'callback') {
      callbacks.push(value);
    }
  });

  // Use https to avoid mixed content warnings in client pages and to
  // prevent a MITM from rewrite prettify mid-flight.
  // This only works if this script is loaded via https : something
  // over which we exercise no control.
  const LOADER_BASE_URL =
    'https://cdn.rawgit.com/google/code-prettify/master/loader';

  for (var i = 0, n = langs.length; i < n; ++i)
    ((lang) => {
      let script = doc.createElement('script');

      // Excerpted from jQuery.ajaxTransport("script") to fire events when
      // a script is finished loading.
      // Attach handlers for each script
      script.onload =
        script.onerror =
        script.onreadystatechange =
          () => {
            if (
              script &&
              (!script.readyState || /loaded|complete/.test(script.readyState))
            ) {
              // Handle memory leak in IE
              script.onerror = script.onload = script.onreadystatechange = null;

              --pendingLanguages;
              checkPendingLanguages();

              // Remove the script
              if (script.parentNode) {
                script.parentNode.removeChild(script);
              }

              script = null;
            }
          };

      script.type = 'text/javascript';
      script.src =
        LOADER_BASE_URL + '/lang-' + encodeURIComponent(langs[i]) + '.js';

      // Circumvent IE6 bugs with base elements (#2709 and #4378) by prepending
      head.insertBefore(script, head.firstChild);
    })(langs[i]);

  var pendingLanguages = langs.length;
  function checkPendingLanguages() {
    if (!pendingLanguages) {
      win.setTimeout(onLangsLoaded, 0);
    }
  }

  const skinUrls = [];
  for (var i = 0, n = skins.length; i < n; ++i) {
    skinUrls.push(
      LOADER_BASE_URL + '/skins/' + encodeURIComponent(skins[i]) + '.css'
    );
  }
  skinUrls.push(LOADER_BASE_URL + '/prettify.css');
  loadStylesheetsFallingBack(skinUrls);

  const prettyPrint = (() => {
    /**
     * @license
     * Copyright (C) 2006 Google Inc.
     *
     * Licensed under the Apache License, Version 2.0 (the "License");
     * you may not use this file except in compliance with the License.
     * You may obtain a copy of the License at
     *
     *      http://www.apache.org/licenses/LICENSE-2.0
     *
     * Unless required by applicable law or agreed to in writing, software
     * distributed under the License is distributed on an "AS IS" BASIS,
     * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
     * See the License for the specific language governing permissions and
     * limitations under the License.
     */

    /**
     * @fileoverview
     * some functions for browser-side pretty printing of code contained in html.
     *
     * <p>
     * For a fairly comprehensive set of languages see the
     * <a href="https://github.com/google/code-prettify#for-which-languages-does-it-work">README</a>
     * file that came with this source.  At a minimum, the lexer should work on a
     * number of languages including C and friends, Java, Python, Bash, SQL, HTML,
     * XML, CSS, Javascript, and Makefiles.  It works passably on Ruby, PHP and Awk
     * and a subset of Perl, but, because of commenting conventions, doesn't work on
     * Smalltalk, Lisp-like, or CAML-like languages without an explicit lang class.
     * <p>
     * Usage: <ol>
     * <li> include this source file in an html page via
     *   {@code <script type="text/javascript" src="/path/to/prettify.js"></script>}
     * <li> define style rules.  See the example page for examples.
     * <li> mark the {@code <pre>} and {@code <code>} tags in your source with
     *    {@code class=prettyprint.}
     *    You can also use the (html deprecated) {@code <xmp>} tag, but the pretty
     *    printer needs to do more substantial DOM manipulations to support that, so
     *    some css styles may not be preserved.
     * </ol>
     * That's it.  I wanted to keep the API as simple as possible, so there's no
     * need to specify which language the code is in, but if you wish, you can add
     * another class to the {@code <pre>} or {@code <code>} element to specify the
     * language, as in {@code <pre class="prettyprint lang-java">}.  Any class that
     * starts with "lang-" followed by a file extension, specifies the file type.
     * See the "lang-*.js" files in this directory for code that implements
     * per-language file handlers.
     * <p>
     * Change log:<br>
     * cbeust, 2006/08/22
     * <blockquote>
     *   Java annotations (start with "@") are now captured as literals ("lit")
     * </blockquote>
     * @requires console
     */

    // JSLint declarations
    /*global console, document, navigator, setTimeout, window, define */

    let HACK_TO_FIX_JS_INCLUDE_PL;

    /**
     * {@type !{
     *   'createSimpleLexer': function (Array, Array): (function (JobT)),
     *   'registerLangHandler': function (function (JobT), Array.<string>),
     *   'PR_ATTRIB_NAME': string,
     *   'PR_ATTRIB_NAME': string,
     *   'PR_ATTRIB_VALUE': string,
     *   'PR_COMMENT': string,
     *   'PR_DECLARATION': string,
     *   'PR_KEYWORD': string,
     *   'PR_LITERAL': string,
     *   'PR_NOCODE': string,
     *   'PR_PLAIN': string,
     *   'PR_PUNCTUATION': string,
     *   'PR_SOURCE': string,
     *   'PR_STRING': string,
     *   'PR_TAG': string,
     *   'PR_TYPE': string,
     *   'prettyPrintOne': function (string, string, number|boolean),
     *   'prettyPrint': function (?function, ?(HTMLElement|HTMLDocument))
     * }}
     * @const
     */
    let PR;

    /**
     * Split {@code prettyPrint} into multiple timeouts so as not to interfere with
     * UI events.
     * If set to {@code false}, {@code prettyPrint()} is synchronous.
     */
    window['PR_SHOULD_USE_CONTINUATION'] = true;

    /**
     * Pretty print a chunk of code.
     * @param {string} sourceCodeHtml The HTML to pretty print.
     * @param {string} opt_langExtension The language name to use.
     *     Typically, a filename extension like 'cpp' or 'java'.
     * @param {number|boolean} opt_numberLines True to number lines,
     *     or the 1-indexed number of the first line in sourceCodeHtml.
     * @return {string} code as html, but prettier
     */
    let prettyPrintOne;
    /**
     * Find all the {@code <pre>} and {@code <code>} tags in the DOM with
     * {@code class=prettyprint} and prettify them.
     *
     * @param {Function} opt_whenDone called when prettifying is done.
     * @param {HTMLElement|HTMLDocument} opt_root an element or document
     *   containing all the elements to pretty print.
     *   Defaults to {@code document.body}.
     */
    let prettyPrint;

    (() => {
      const win = window;
      // Keyword lists for various languages.
      // We use things that coerce to strings to make them compact when minified
      // and to defeat aggressive optimizers that fold large string constants.
      const FLOW_CONTROL_KEYWORDS = [
        'break,continue,do,else,for,if,return,while',
      ];
      const C_KEYWORDS = [
        FLOW_CONTROL_KEYWORDS,
        'auto,case,char,const,default,' +
          'double,enum,extern,float,goto,inline,int,long,register,restrict,short,signed,' +
          'sizeof,static,struct,switch,typedef,union,unsigned,void,volatile',
      ];
      const COMMON_KEYWORDS = [
        C_KEYWORDS,
        'catch,class,delete,false,import,' +
          'new,operator,private,protected,public,this,throw,true,try,typeof',
      ];
      const CPP_KEYWORDS = [
        COMMON_KEYWORDS,
        'alignas,alignof,align_union,asm,axiom,bool,' +
          'concept,concept_map,const_cast,constexpr,decltype,delegate,' +
          'dynamic_cast,explicit,export,friend,generic,late_check,' +
          'mutable,namespace,noexcept,noreturn,nullptr,property,reinterpret_cast,static_assert,' +
          'static_cast,template,typeid,typename,using,virtual,where',
      ];
      const JAVA_KEYWORDS = [
        COMMON_KEYWORDS,
        'abstract,assert,boolean,byte,extends,finally,final,implements,import,' +
          'instanceof,interface,null,native,package,strictfp,super,synchronized,' +
          'throws,transient',
      ];
      const CSHARP_KEYWORDS = [
        COMMON_KEYWORDS,
        'abstract,add,alias,as,ascending,async,await,base,bool,by,byte,checked,decimal,delegate,descending,' +
          'dynamic,event,finally,fixed,foreach,from,get,global,group,implicit,in,interface,' +
          'internal,into,is,join,let,lock,null,object,out,override,orderby,params,' +
          'partial,readonly,ref,remove,sbyte,sealed,select,set,stackalloc,string,select,uint,ulong,' +
          'unchecked,unsafe,ushort,value,var,virtual,where,yield',
      ];
      const COFFEE_KEYWORDS =
        'all,and,by,catch,class,else,extends,false,finally,' +
        'for,if,in,is,isnt,loop,new,no,not,null,of,off,on,or,return,super,then,' +
        'throw,true,try,unless,until,when,while,yes';
      const JSCRIPT_KEYWORDS = [
        COMMON_KEYWORDS,
        'abstract,async,await,constructor,debugger,enum,eval,export,function,' +
          'get,implements,instanceof,interface,let,null,set,undefined,var,with,' +
          'yield,Infinity,NaN',
      ];
      const PERL_KEYWORDS =
        'caller,delete,die,do,dump,elsif,eval,exit,foreach,for,' +
        'goto,if,import,last,local,my,next,no,our,print,package,redo,require,' +
        'sub,undef,unless,until,use,wantarray,while,BEGIN,END';
      const PYTHON_KEYWORDS = [
        FLOW_CONTROL_KEYWORDS,
        'and,as,assert,class,def,del,' +
          'elif,except,exec,finally,from,global,import,in,is,lambda,' +
          'nonlocal,not,or,pass,print,raise,try,with,yield,' +
          'False,True,None',
      ];
      const RUBY_KEYWORDS = [
        FLOW_CONTROL_KEYWORDS,
        'alias,and,begin,case,class,' +
          'def,defined,elsif,end,ensure,false,in,module,next,nil,not,or,redo,' +
          'rescue,retry,self,super,then,true,undef,unless,until,when,yield,' +
          'BEGIN,END',
      ];
      const SH_KEYWORDS = [
        FLOW_CONTROL_KEYWORDS,
        'case,done,elif,esac,eval,fi,' + 'function,in,local,set,then,until',
      ];
      const ALL_KEYWORDS = [
        CPP_KEYWORDS,
        CSHARP_KEYWORDS,
        JAVA_KEYWORDS,
        JSCRIPT_KEYWORDS,
        PERL_KEYWORDS,
        PYTHON_KEYWORDS,
        RUBY_KEYWORDS,
        SH_KEYWORDS,
      ];
      const C_TYPES =
        /^(DIR|FILE|array|vector|(de|priority_)?queue|(forward_)?list|stack|(const_)?(reverse_)?iterator|(unordered_)?(multi)?(set|map)|bitset|u?(int|float)\d*)\b/;

      // token style names.  correspond to css classes
      /**
       * token style for a string literal
       * @const
       */
      const PR_STRING = 'str';
      /**
       * token style for a keyword
       * @const
       */
      const PR_KEYWORD = 'kwd';
      /**
       * token style for a comment
       * @const
       */
      const PR_COMMENT = 'com';
      /**
       * token style for a type
       * @const
       */
      const PR_TYPE = 'typ';
      /**
       * token style for a literal value.  e.g. 1, null, true.
       * @const
       */
      const PR_LITERAL = 'lit';
      /**
       * token style for a punctuation string.
       * @const
       */
      const PR_PUNCTUATION = 'pun';
      /**
       * token style for plain text.
       * @const
       */
      const PR_PLAIN = 'pln';

      /**
       * token style for an sgml tag.
       * @const
       */
      const PR_TAG = 'tag';
      /**
       * token style for a markup declaration such as a DOCTYPE.
       * @const
       */
      const PR_DECLARATION = 'dec';
      /**
       * token style for embedded source.
       * @const
       */
      const PR_SOURCE = 'src';
      /**
       * token style for an sgml attribute name.
       * @const
       */
      const PR_ATTRIB_NAME = 'atn';
      /**
       * token style for an sgml attribute value.
       * @const
       */
      const PR_ATTRIB_VALUE = 'atv';

      /**
       * A class that indicates a section of markup that is not code, e.g. to allow
       * embedding of line numbers within code listings.
       * @const
       */
      const PR_NOCODE = 'nocode';

      /**
       * A set of tokens that can precede a regular expression literal in
       * javascript
       * http://web.archive.org/web/20070717142515/http://www.mozilla.org/js/language/js20/rationale/syntax.html
       * has the full list, but I've removed ones that might be problematic when
       * seen in languages that don't support regular expression literals.
       *
       * <p>Specifically, I've removed any keywords that can't precede a regexp
       * literal in a syntactically legal javascript program, and I've removed the
       * "in" keyword since it's not a keyword in many languages, and might be used
       * as a count of inches.
       *
       * <p>The link above does not accurately describe EcmaScript rules since
       * it fails to distinguish between (a=++/b/i) and (a++/b/i) but it works
       * very well in practice.
       *
       * @private
       * @const
       */
      const REGEXP_PRECEDER_PATTERN =
        '(?:^^\\.?|[+-]|[!=]=?=?|\\#|%=?|&&?=?|\\(|\\*=?|[+\\-]=|->|\\/=?|::?|<<?=?|>>?>?=?|,|;|\\?|@|\\[|~|{|\\^\\^?=?|\\|\\|?=?|break|case|continue|delete|do|else|finally|instanceof|return|throw|try|typeof)\\s*';

      // CAVEAT: this does not properly handle the case where a regular
      // expression immediately follows another since a regular expression may
      // have flags for case-sensitivity and the like.  Having regexp tokens
      // adjacent is not valid in any language I'm aware of, so I'm punting.
      // TODO: maybe style special characters inside a regexp as punctuation.

      /**
       * Given a group of {@link RegExp}s, returns a {@code RegExp} that globally
       * matches the union of the sets of strings matched by the input RegExp.
       * Since it matches globally, if the input strings have a start-of-input
       * anchor (/^.../), it is ignored for the purposes of unioning.
       * @param {Array.<RegExp>} regexs non multiline, non-global regexs.
       * @return {RegExp} a global regex.
       */
      function combinePrefixPatterns(regexs) {
        let capturedGroupIndex = 0;

        let needToFoldCase = false;
        let ignoreCase = false;
        for (var i = 0, n = regexs.length; i < n; ++i) {
          var regex = regexs[i];
          if (regex.ignoreCase) {
            ignoreCase = true;
          } else if (
            /[a-z]/i.test(
              regex.source.replace(
                /\\u[0-9a-f]{4}|\\x[0-9a-f]{2}|\\[^ux]/gi,
                ''
              )
            )
          ) {
            needToFoldCase = true;
            ignoreCase = false;
            break;
          }
        }

        const escapeCharToCodeUnit = {
          b: 8,
          t: 9,
          n: 0xa,
          v: 0xb,
          f: 0xc,
          r: 0xd,
        };

        function decodeEscape(charsetPart) {
          let cc0 = charsetPart.charCodeAt(0);
          if (cc0 !== 92 /* \\ */) {
            return cc0;
          }
          const c1 = charsetPart.charAt(1);
          cc0 = escapeCharToCodeUnit[c1];
          if (cc0) {
            return cc0;
          } else if ('0' <= c1 && c1 <= '7') {
            return parseInt(charsetPart.substring(1), 8);
          } else if (c1 === 'u' || c1 === 'x') {
            return parseInt(charsetPart.substring(2), 16);
          } else {
            return charsetPart.charCodeAt(1);
          }
        }

        function encodeEscape(charCode) {
          if (charCode < 0x20) {
            return (charCode < 0x10 ? '\\x0' : '\\x') + charCode.toString(16);
          }
          const ch = String.fromCharCode(charCode);
          return ch === '\\' || ch === '-' || ch === ']' || ch === '^'
            ? '\\' + ch
            : ch;
        }

        function caseFoldCharset(charSet) {
          const charsetParts = charSet
            .substring(1, charSet.length - 1)
            .match(
              new RegExp(
                '\\\\u[0-9A-Fa-f]{4}' +
                  '|\\\\x[0-9A-Fa-f]{2}' +
                  '|\\\\[0-3][0-7]{0,2}' +
                  '|\\\\[0-7]{1,2}' +
                  '|\\\\[\\s\\S]' +
                  '|-' +
                  '|[^-\\\\]',
                'g'
              )
            );
          const ranges = [];
          const inverse = charsetParts[0] === '^';

          const out = ['['];
          if (inverse) {
            out.push('^');
          }

          for (var i = inverse ? 1 : 0, n = charsetParts.length; i < n; ++i) {
            const p = charsetParts[i];
            if (/\\[bdsw]/i.test(p)) {
              // Don't muck with named groups.
              out.push(p);
            } else {
              const start = decodeEscape(p);
              let end;
              if (i + 2 < n && '-' === charsetParts[i + 1]) {
                end = decodeEscape(charsetParts[i + 2]);
                i += 2;
              } else {
                end = start;
              }
              ranges.push([start, end]);
              // If the range might intersect letters, then expand it.
              // This case handling is too simplistic.
              // It does not deal with non-latin case folding.
              // It works for latin source code identifiers though.
              if (!(end < 65 || start > 122)) {
                if (!(end < 65 || start > 90)) {
                  ranges.push([
                    Math.max(65, start) | 32,
                    Math.min(end, 90) | 32,
                  ]);
                }
                if (!(end < 97 || start > 122)) {
                  ranges.push([
                    Math.max(97, start) & ~32,
                    Math.min(end, 122) & ~32,
                  ]);
                }
              }
            }
          }

          // [[1, 10], [3, 4], [8, 12], [14, 14], [16, 16], [17, 17]]
          // -> [[1, 12], [14, 14], [16, 17]]
          ranges.sort((a, b) => {
            return a[0] - b[0] || b[1] - a[1];
          });
          const consolidatedRanges = [];
          let lastRange = [];
          for (var i = 0; i < ranges.length; ++i) {
            var range = ranges[i];
            if (range[0] <= lastRange[1] + 1) {
              lastRange[1] = Math.max(lastRange[1], range[1]);
            } else {
              consolidatedRanges.push((lastRange = range));
            }
          }

          for (var i = 0; i < consolidatedRanges.length; ++i) {
            var range = consolidatedRanges[i];
            out.push(encodeEscape(range[0]));
            if (range[1] > range[0]) {
              if (range[1] + 1 > range[0]) {
                out.push('-');
              }
              out.push(encodeEscape(range[1]));
            }
          }
          out.push(']');
          return out.join('');
        }

        function allowAnywhereFoldCaseAndRenumberGroups(regex) {
          // Split into character sets, escape sequences, punctuation strings
          // like ('(', '(?:', ')', '^'), and runs of characters that do not
          // include any of the above.
          const parts = regex.source.match(
            new RegExp(
              '(?:' +
                '\\[(?:[^\\x5C\\x5D]|\\\\[\\s\\S])*\\]' + // a character set
                '|\\\\u[A-Fa-f0-9]{4}' + // a unicode escape
                '|\\\\x[A-Fa-f0-9]{2}' + // a hex escape
                '|\\\\[0-9]+' + // a back-reference or octal escape
                '|\\\\[^ux0-9]' + // other escape sequence
                '|\\(\\?[:!=]' + // start of a non-capturing group
                '|[\\(\\)\\^]' + // start/end of a group, or line start
                '|[^\\x5B\\x5C\\(\\)\\^]+' + // run of other characters
                ')',
              'g'
            )
          );
          const n = parts.length;

          // Maps captured group numbers to the number they will occupy in
          // the output or to -1 if that has not been determined, or to
          // undefined if they need not be capturing in the output.
          const capturedGroups = [];

          // Walk over and identify back references to build the capturedGroups
          // mapping.
          for (var i = 0, groupIndex = 0; i < n; ++i) {
            var p = parts[i];
            if (p === '(') {
              // groups are 1-indexed, so max group index is count of '('
              ++groupIndex;
            } else if ('\\' === p.charAt(0)) {
              var decimalValue = +p.substring(1);
              if (decimalValue) {
                if (decimalValue <= groupIndex) {
                  capturedGroups[decimalValue] = -1;
                } else {
                  // Replace with an unambiguous escape sequence so that
                  // an octal escape sequence does not turn into a backreference
                  // to a capturing group from an earlier regex.
                  parts[i] = encodeEscape(decimalValue);
                }
              }
            }
          }

          // Renumber groups and reduce capturing groups to non-capturing groups
          // where possible.
          for (var i = 1; i < capturedGroups.length; ++i) {
            if (-1 === capturedGroups[i]) {
              capturedGroups[i] = ++capturedGroupIndex;
            }
          }
          for (var i = 0, groupIndex = 0; i < n; ++i) {
            var p = parts[i];
            if (p === '(') {
              ++groupIndex;
              if (!capturedGroups[groupIndex]) {
                parts[i] = '(?:';
              }
            } else if ('\\' === p.charAt(0)) {
              var decimalValue = +p.substring(1);
              if (decimalValue && decimalValue <= groupIndex) {
                parts[i] = '\\' + capturedGroups[decimalValue];
              }
            }
          }

          // Remove any prefix anchors so that the output will match anywhere.
          // ^^ really does mean an anchored match though.
          for (var i = 0; i < n; ++i) {
            if ('^' === parts[i] && '^' !== parts[i + 1]) {
              parts[i] = '';
            }
          }

          // Expand letters to groups to handle mixing of case-sensitive and
          // case-insensitive patterns if necessary.
          if (regex.ignoreCase && needToFoldCase) {
            for (var i = 0; i < n; ++i) {
              var p = parts[i];
              const ch0 = p.charAt(0);
              if (p.length >= 2 && ch0 === '[') {
                parts[i] = caseFoldCharset(p);
              } else if (ch0 !== '\\') {
                // TODO: handle letters in numeric escapes.
                parts[i] = p.replace(/[a-zA-Z]/g, (ch) => {
                  const cc = ch.charCodeAt(0);
                  return '[' + String.fromCharCode(cc & ~32, cc | 32) + ']';
                });
              }
            }
          }

          return parts.join('');
        }

        const rewritten = [];
        for (var i = 0, n = regexs.length; i < n; ++i) {
          var regex = regexs[i];
          if (regex.global || regex.multiline) {
            throw new Error('' + regex);
          }
          rewritten.push(
            '(?:' + allowAnywhereFoldCaseAndRenumberGroups(regex) + ')'
          );
        }

        return new RegExp(rewritten.join('|'), ignoreCase ? 'gi' : 'g');
      }

      /**
       * Split markup into a string of source code and an array mapping ranges in
       * that string to the text nodes in which they appear.
       *
       * <p>
       * The HTML DOM structure:</p>
       * <pre>
       * (Element   "p"
       *   (Element "b"
       *     (Text  "print "))       ; #1
       *   (Text    "'Hello '")      ; #2
       *   (Element "br")            ; #3
       *   (Text    "  + 'World';")) ; #4
       * </pre>
       * <p>
       * corresponds to the HTML
       * {@code <p><b>print </b>'Hello '<br>  + 'World';</p>}.</p>
       *
       * <p>
       * It will produce the output:</p>
       * <pre>
       * {
       *   sourceCode: "print 'Hello '\n  + 'World';",
       *   //                     1          2
       *   //           012345678901234 5678901234567
       *   spans: [0, #1, 6, #2, 14, #3, 15, #4]
       * }
       * </pre>
       * <p>
       * where #1 is a reference to the {@code "print "} text node above, and so
       * on for the other text nodes.
       * </p>
       *
       * <p>
       * The {@code} spans array is an array of pairs.  Even elements are the start
       * indices of substrings, and odd elements are the text nodes (or BR elements)
       * that contain the text for those substrings.
       * Substrings continue until the next index or the end of the source.
       * </p>
       *
       * @param {Node} node an HTML DOM subtree containing source-code.
       * @param {boolean|number} isPreformatted truthy if white-space in
       *    text nodes should be considered significant.
       * @return {SourceSpansT} source code and the nodes in which they occur.
       */
      function extractSourceSpans(node, isPreformatted) {
        const nocode = /(?:^|\s)nocode(?:\s|$)/;

        const chunks = [];
        let length = 0;
        const spans = [];
        let k = 0;

        function walk(node) {
          const type = node.nodeType;
          if (type == 1) {
            // Element
            if (nocode.test(node.className)) {
              return;
            }
            for (
              let child = node.firstChild;
              child;
              child = child.nextSibling
            ) {
              walk(child);
            }
            const nodeName = node.nodeName.toLowerCase();
            if ('br' === nodeName || 'li' === nodeName) {
              chunks[k] = '\n';
              spans[k << 1] = length++;
              spans[(k++ << 1) | 1] = node;
            }
          } else if (type == 3 || type == 4) {
            // Text
            let text = node.nodeValue;
            if (text.length) {
              if (!isPreformatted) {
                text = text.replace(/[ \t\r\n]+/g, ' ');
              } else {
                text = text.replace(/\r\n?/g, '\n'); // Normalize newlines.
              }
              // TODO: handle tabs here?
              chunks[k] = text;
              spans[k << 1] = length;
              length += text.length;
              spans[(k++ << 1) | 1] = node;
            }
          }
        }

        walk(node);

        return {
          sourceCode: chunks.join('').replace(/\n$/, ''),
          spans: spans,
        };
      }

      /**
       * Apply the given language handler to sourceCode and add the resulting
       * decorations to out.
       * @param {!Element} sourceNode
       * @param {number} basePos the index of sourceCode within the chunk of source
       *    whose decorations are already present on out.
       * @param {string} sourceCode
       * @param {function(JobT)} langHandler
       * @param {DecorationsT} out
       */
      function appendDecorations(
        sourceNode,
        basePos,
        sourceCode,
        langHandler,
        out
      ) {
        if (!sourceCode) {
          return;
        }
        /** @type {JobT} */
        const job = {
          sourceNode: sourceNode,
          pre: 1,
          langExtension: null,
          numberLines: null,
          sourceCode: sourceCode,
          spans: null,
          basePos: basePos,
          decorations: null,
        };
        langHandler(job);
        out.push.apply(out, job.decorations);
      }

      const notWs = /\S/;

      /**
       * Given an element, if it contains only one child element and any text nodes
       * it contains contain only space characters, return the sole child element.
       * Otherwise returns undefined.
       * <p>
       * This is meant to return the CODE element in {@code <pre><code ...>} when
       * there is a single child element that contains all the non-space textual
       * content, but not to return anything where there are multiple child elements
       * as in {@code <pre><code>...</code><code>...</code></pre>} or when there
       * is textual content.
       */
      function childContentWrapper(element) {
        let wrapper = undefined;
        for (let c = element.firstChild; c; c = c.nextSibling) {
          const type = c.nodeType;
          wrapper =
            type === 1 // Element Node
              ? wrapper
                ? element
                : c
              : type === 3 // Text Node
              ? notWs.test(c.nodeValue)
                ? element
                : wrapper
              : wrapper;
        }
        return wrapper === element ? undefined : wrapper;
      }

      /** Given triples of [style, pattern, context] returns a lexing function,
       * The lexing function interprets the patterns to find token boundaries and
       * returns a decoration list of the form
       * [index_0, style_0, index_1, style_1, ..., index_n, style_n]
       * where index_n is an index into the sourceCode, and style_n is a style
       * constant like PR_PLAIN.  index_n-1 <= index_n, and style_n-1 applies to
       * all characters in sourceCode[index_n-1:index_n].
       *
       * The stylePatterns is a list whose elements have the form
       * [style : string, pattern : RegExp, DEPRECATED, shortcut : string].
       *
       * Style is a style constant like PR_PLAIN, or can be a string of the
       * form 'lang-FOO', where FOO is a language extension describing the
       * language of the portion of the token in $1 after pattern executes.
       * E.g., if style is 'lang-lisp', and group 1 contains the text
       * '(hello (world))', then that portion of the token will be passed to the
       * registered lisp handler for formatting.
       * The text before and after group 1 will be restyled using this decorator
       * so decorators should take care that this doesn't result in infinite
       * recursion.  For example, the HTML lexer rule for SCRIPT elements looks
       * something like ['lang-js', /<[s]cript>(.+?)<\/script>/].  This may match
       * '<script>foo()<\/script>', which would cause the current decorator to
       * be called with '<script>' which would not match the same rule since
       * group 1 must not be empty, so it would be instead styled as PR_TAG by
       * the generic tag rule.  The handler registered for the 'js' extension would
       * then be called with 'foo()', and finally, the current decorator would
       * be called with '<\/script>' which would not match the original rule and
       * so the generic tag rule would identify it as a tag.
       *
       * Pattern must only match prefixes, and if it matches a prefix, then that
       * match is considered a token with the same style.
       *
       * Context is applied to the last non-whitespace, non-comment token
       * recognized.
       *
       * Shortcut is an optional string of characters, any of which, if the first
       * character, gurantee that this pattern and only this pattern matches.
       *
       * @param {Array} shortcutStylePatterns patterns that always start with
       *   a known character.  Must have a shortcut string.
       * @param {Array} fallthroughStylePatterns patterns that will be tried in
       *   order if the shortcut ones fail.  May have shortcuts.
       *
       * @return {function (JobT)} a function that takes an undecorated job and
       *   attaches a list of decorations.
       */
      function createSimpleLexer(
        shortcutStylePatterns,
        fallthroughStylePatterns
      ) {
        const shortcuts = {};
        let tokenizer;
        (() => {
          const allPatterns = shortcutStylePatterns.concat(
            fallthroughStylePatterns
          );
          const allRegexs = [];
          const regexKeys = {};
          for (let i = 0, n = allPatterns.length; i < n; ++i) {
            const patternParts = allPatterns[i];
            const shortcutChars = patternParts[3];
            if (shortcutChars) {
              for (let c = shortcutChars.length; --c >= 0; ) {
                shortcuts[shortcutChars.charAt(c)] = patternParts;
              }
            }
            const regex = patternParts[1];
            const k = '' + regex;
            if (!regexKeys.hasOwnProperty(k)) {
              allRegexs.push(regex);
              regexKeys[k] = null;
            }
          }
          allRegexs.push(/[\0-\uffff]/);
          tokenizer = combinePrefixPatterns(allRegexs);
        })();

        const nPatterns = fallthroughStylePatterns.length;

        /**
         * Lexes job.sourceCode and attaches an output array job.decorations of
         * style classes preceded by the position at which they start in
         * job.sourceCode in order.
         *
         * @type{function (JobT)}
         */
        const decorate = (job) => {
          const sourceCode = job.sourceCode,
            basePos = job.basePos;
          const sourceNode = job.sourceNode;
          /** Even entries are positions in source in ascending order.  Odd enties
           * are style markers (e.g., PR_COMMENT) that run from that position until
           * the end.
           * @type {DecorationsT}
           */
          const decorations = [basePos, PR_PLAIN];
          let pos = 0; // index into sourceCode
          const tokens = sourceCode.match(tokenizer) || [];
          const styleCache = {};

          for (let ti = 0, nTokens = tokens.length; ti < nTokens; ++ti) {
            const token = tokens[ti];
            let style = styleCache[token];
            let match = void 0;

            let isEmbedded;
            if (typeof style === 'string') {
              isEmbedded = false;
            } else {
              let patternParts = shortcuts[token.charAt(0)];
              if (patternParts) {
                match = token.match(patternParts[1]);
                style = patternParts[0];
              } else {
                for (let i = 0; i < nPatterns; ++i) {
                  patternParts = fallthroughStylePatterns[i];
                  match = token.match(patternParts[1]);
                  if (match) {
                    style = patternParts[0];
                    break;
                  }
                }

                if (!match) {
                  // make sure that we make progress
                  style = PR_PLAIN;
                }
              }

              isEmbedded =
                style.length >= 5 && 'lang-' === style.substring(0, 5);
              if (isEmbedded && !(match && typeof match[1] === 'string')) {
                isEmbedded = false;
                style = PR_SOURCE;
              }

              if (!isEmbedded) {
                styleCache[token] = style;
              }
            }

            const tokenStart = pos;
            pos += token.length;

            if (!isEmbedded) {
              decorations.push(basePos + tokenStart, style);
            } else {
              // Treat group 1 as an embedded block of source code.
              const embeddedSource = match[1];
              let embeddedSourceStart = token.indexOf(embeddedSource);
              let embeddedSourceEnd =
                embeddedSourceStart + embeddedSource.length;
              if (match[2]) {
                // If embeddedSource can be blank, then it would match at the
                // beginning which would cause us to infinitely recurse on the
                // entire token, so we catch the right context in match[2].
                embeddedSourceEnd = token.length - match[2].length;
                embeddedSourceStart = embeddedSourceEnd - embeddedSource.length;
              }
              const lang = style.substring(5);
              // Decorate the left of the embedded source
              appendDecorations(
                sourceNode,
                basePos + tokenStart,
                token.substring(0, embeddedSourceStart),
                decorate,
                decorations
              );
              // Decorate the embedded source
              appendDecorations(
                sourceNode,
                basePos + tokenStart + embeddedSourceStart,
                embeddedSource,
                langHandlerForExtension(lang, embeddedSource),
                decorations
              );
              // Decorate the right of the embedded section
              appendDecorations(
                sourceNode,
                basePos + tokenStart + embeddedSourceEnd,
                token.substring(embeddedSourceEnd),
                decorate,
                decorations
              );
            }
          }
          job.decorations = decorations;
        };
        return decorate;
      }

      /** returns a function that produces a list of decorations from source text.
       *
       * This code treats ", ', and ` as string delimiters, and \ as a string
       * escape.  It does not recognize perl's qq() style strings.
       * It has no special handling for double delimiter escapes as in basic, or
       * the tripled delimiters used in python, but should work on those regardless
       * although in those cases a single string literal may be broken up into
       * multiple adjacent string literals.
       *
       * It recognizes C, C++, and shell style comments.
       *
       * @param {Object} options a set of optional parameters.
       * @return {function (JobT)} a function that examines the source code
       *     in the input job and builds a decoration list which it attaches to
       *     the job.
       */
      function sourceDecorator(options) {
        const shortcutStylePatterns = [],
          fallthroughStylePatterns = [];
        if (options['tripleQuotedStrings']) {
          // '''multi-line-string''', 'single-line-string', and double-quoted
          shortcutStylePatterns.push([
            PR_STRING,
            /^(?:\'\'\'(?:[^\'\\]|\\[\s\S]|\'{1,2}(?=[^\']))*(?:\'\'\'|$)|\"\"\"(?:[^\"\\]|\\[\s\S]|\"{1,2}(?=[^\"]))*(?:\"\"\"|$)|\'(?:[^\\\']|\\[\s\S])*(?:\'|$)|\"(?:[^\\\"]|\\[\s\S])*(?:\"|$))/,
            null,
            '\'"',
          ]);
        } else if (options['multiLineStrings']) {
          // 'multi-line-string', "multi-line-string"
          shortcutStylePatterns.push([
            PR_STRING,
            /^(?:\'(?:[^\\\']|\\[\s\S])*(?:\'|$)|\"(?:[^\\\"]|\\[\s\S])*(?:\"|$)|\`(?:[^\\\`]|\\[\s\S])*(?:\`|$))/,
            null,
            '\'"`',
          ]);
        } else {
          // 'single-line-string', "single-line-string"
          shortcutStylePatterns.push([
            PR_STRING,
            /^(?:\'(?:[^\\\'\r\n]|\\.)*(?:\'|$)|\"(?:[^\\\"\r\n]|\\.)*(?:\"|$))/,
            null,
            '"\'',
          ]);
        }
        if (options['verbatimStrings']) {
          // verbatim-string-literal production from the C# grammar.  See issue 93.
          fallthroughStylePatterns.push([
            PR_STRING,
            /^@\"(?:[^\"]|\"\")*(?:\"|$)/,
            null,
          ]);
        }
        const hc = options['hashComments'];
        if (hc) {
          if (options['cStyleComments']) {
            if (hc > 1) {
              // multiline hash comments
              shortcutStylePatterns.push([
                PR_COMMENT,
                /^#(?:##(?:[^#]|#(?!##))*(?:###|$)|.*)/,
                null,
                '#',
              ]);
            } else {
              // Stop C preprocessor declarations at an unclosed open comment
              shortcutStylePatterns.push([
                PR_COMMENT,
                /^#(?:(?:define|e(?:l|nd)if|else|error|ifn?def|include|line|pragma|undef|warning)\b|[^\r\n]*)/,
                null,
                '#',
              ]);
            }
            // #include <stdio.h>
            fallthroughStylePatterns.push([
              PR_STRING,
              /^<(?:(?:(?:\.\.\/)*|\/?)(?:[\w-]+(?:\/[\w-]+)+)?[\w-]+\.h(?:h|pp|\+\+)?|[a-z]\w*)>/,
              null,
            ]);
          } else {
            shortcutStylePatterns.push([PR_COMMENT, /^#[^\r\n]*/, null, '#']);
          }
        }
        if (options['cStyleComments']) {
          fallthroughStylePatterns.push([PR_COMMENT, /^\/\/[^\r\n]*/, null]);
          fallthroughStylePatterns.push([
            PR_COMMENT,
            /^\/\*[\s\S]*?(?:\*\/|$)/,
            null,
          ]);
        }
        const regexLiterals = options['regexLiterals'];
        if (regexLiterals) {
          /**
           * @const
           */
          const regexExcls =
            regexLiterals > 1
              ? '' // Multiline regex literals
              : '\n\r';
          /**
           * @const
           */
          const regexAny = regexExcls ? '.' : '[\\S\\s]';
          /**
           * @const
           */
          const REGEX_LITERAL =
            // A regular expression literal starts with a slash that is
            // not followed by * or / so that it is not confused with
            // comments.
            '/(?=[^/*' +
            regexExcls +
            '])' +
            // and then contains any number of raw characters,
            '(?:[^/\\x5B\\x5C' +
            regexExcls +
            ']' +
            // escape sequences (\x5C),
            '|\\x5C' +
            regexAny +
            // or non-nesting character sets (\x5B\x5D);
            '|\\x5B(?:[^\\x5C\\x5D' +
            regexExcls +
            ']' +
            '|\\x5C' +
            regexAny +
            ')*(?:\\x5D|$))+' +
            // finally closed by a /.
            '/';
          fallthroughStylePatterns.push([
            'lang-regex',
            RegExp('^' + REGEXP_PRECEDER_PATTERN + '(' + REGEX_LITERAL + ')'),
          ]);
        }

        const types = options['types'];
        if (types) {
          fallthroughStylePatterns.push([PR_TYPE, types]);
        }

        const keywords = ('' + options['keywords']).replace(/^ | $/g, '');
        if (keywords.length) {
          fallthroughStylePatterns.push([
            PR_KEYWORD,
            new RegExp('^(?:' + keywords.replace(/[\s,]+/g, '|') + ')\\b'),
            null,
          ]);
        }

        shortcutStylePatterns.push([PR_PLAIN, /^\s+/, null, ' \r\n\t\xA0']);

        let punctuation =
          // The Bash man page says

          // A word is a sequence of characters considered as a single
          // unit by GRUB. Words are separated by metacharacters,
          // which are the following plus space, tab, and newline: { }
          // | & $ ; < >
          // ...

          // A word beginning with # causes that word and all remaining
          // characters on that line to be ignored.

          // which means that only a '#' after /(?:^|[{}|&$;<>\s])/ starts a
          // comment but empirically
          // $ echo {#}
          // {#}
          // $ echo \$#
          // $#
          // $ echo }#
          // }#

          // so /(?:^|[|&;<>\s])/ is more appropriate.

          // http://gcc.gnu.org/onlinedocs/gcc-2.95.3/cpp_1.html#SEC3
          // suggests that this definition is compatible with a
          // default mode that tries to use a single token definition
          // to recognize both bash/python style comments and C
          // preprocessor directives.

          // This definition of punctuation does not include # in the list of
          // follow-on exclusions, so # will not be broken before if preceeded
          // by a punctuation character.  We could try to exclude # after
          // [|&;<>] but that doesn't seem to cause many major problems.
          // If that does turn out to be a problem, we should change the below
          // when hc is truthy to include # in the run of punctuation characters
          // only when not followint [|&;<>].
          '^.[^\\s\\w.$@\'"`/\\\\]*';
        if (options['regexLiterals']) {
          punctuation += '(?!s*/)';
        }

        fallthroughStylePatterns.push(
          // TODO(mikesamuel): recognize non-latin letters and numerals in idents
          [PR_LITERAL, /^@[a-z_$][a-z_$@0-9]*/i, null],
          [PR_TYPE, /^(?:[@_]?[A-Z]+[a-z][A-Za-z_$@0-9]*|\w+_t\b)/, null],
          [PR_PLAIN, /^[a-z_$][a-z_$@0-9]*/i, null],
          [
            PR_LITERAL,
            new RegExp(
              '^(?:' +
                // A hex number
                '0x[a-f0-9]+' +
                // or an octal or decimal number,
                '|(?:\\d(?:_\\d+)*\\d*(?:\\.\\d*)?|\\.\\d\\+)' +
                // possibly in scientific notation
                '(?:e[+\\-]?\\d+)?' +
                ')' +
                // with an optional modifier like UL for unsigned long
                '[a-z]*',
              'i'
            ),
            null,
            '0123456789',
          ],
          // Don't treat escaped quotes in bash as starting strings.
          // See issue 144.
          [PR_PLAIN, /^\\[\s\S]?/, null],
          [PR_PUNCTUATION, new RegExp(punctuation), null]
        );

        return createSimpleLexer(
          shortcutStylePatterns,
          fallthroughStylePatterns
        );
      }

      const decorateSource = sourceDecorator({
        keywords: ALL_KEYWORDS,
        hashComments: true,
        cStyleComments: true,
        multiLineStrings: true,
        regexLiterals: true,
      });

      /**
       * Given a DOM subtree, wraps it in a list, and puts each line into its own
       * list item.
       *
       * @param {Node} node modified in place.  Its content is pulled into an
       *     HTMLOListElement, and each line is moved into a separate list item.
       *     This requires cloning elements, so the input might not have unique
       *     IDs after numbering.
       * @param {number|null|boolean} startLineNum
       *     If truthy, coerced to an integer which is the 1-indexed line number
       *     of the first line of code.  The number of the first line will be
       *     attached to the list.
       * @param {boolean} isPreformatted true iff white-space in text nodes should
       *     be treated as significant.
       */
      function numberLines(node, startLineNum, isPreformatted) {
        const nocode = /(?:^|\s)nocode(?:\s|$)/;
        const lineBreak = /\r\n?|\n/;

        const document = node.ownerDocument;

        let li = document.createElement('li');
        while (node.firstChild) {
          li.appendChild(node.firstChild);
        }
        // An array of lines.  We split below, so this is initialized to one
        // un-split line.
        const listItems = [li];

        function walk(node) {
          const type = node.nodeType;
          if (type == 1 && !nocode.test(node.className)) {
            // Element
            if ('br' === node.nodeName) {
              breakAfter(node);
              // Discard the <BR> since it is now flush against a </LI>.
              if (node.parentNode) {
                node.parentNode.removeChild(node);
              }
            } else {
              for (
                let child = node.firstChild;
                child;
                child = child.nextSibling
              ) {
                walk(child);
              }
            }
          } else if ((type == 3 || type == 4) && isPreformatted) {
            // Text
            const text = node.nodeValue;
            const match = text.match(lineBreak);
            if (match) {
              const firstLine = text.substring(0, match.index);
              node.nodeValue = firstLine;
              const tail = text.substring(match.index + match[0].length);
              if (tail) {
                const parent = node.parentNode;
                parent.insertBefore(
                  document.createTextNode(tail),
                  node.nextSibling
                );
              }
              breakAfter(node);
              if (!firstLine) {
                // Don't leave blank text nodes in the DOM.
                node.parentNode.removeChild(node);
              }
            }
          }
        }

        // Split a line after the given node.
        function breakAfter(lineEndNode) {
          // If there's nothing to the right, then we can skip ending the line
          // here, and move root-wards since splitting just before an end-tag
          // would require us to create a bunch of empty copies.
          while (!lineEndNode.nextSibling) {
            lineEndNode = lineEndNode.parentNode;
            if (!lineEndNode) {
              return;
            }
          }

          function breakLeftOf(limit, copy) {
            // Clone shallowly if this node needs to be on both sides of the break.
            const rightSide = copy ? limit.cloneNode(false) : limit;
            const parent = limit.parentNode;
            if (parent) {
              // We clone the parent chain.
              // This helps us resurrect important styling elements that cross lines.
              // E.g. in <i>Foo<br>Bar</i>
              // should be rewritten to <li><i>Foo</i></li><li><i>Bar</i></li>.
              const parentClone = breakLeftOf(parent, 1);
              // Move the clone and everything to the right of the original
              // onto the cloned parent.
              let next = limit.nextSibling;
              parentClone.appendChild(rightSide);
              for (let sibling = next; sibling; sibling = next) {
                next = sibling.nextSibling;
                parentClone.appendChild(sibling);
              }
            }
            return rightSide;
          }

          let copiedListItem = breakLeftOf(lineEndNode.nextSibling, 0);

          // Walk the parent chain until we reach an unattached LI.
          for (
            let parent;
            // Check nodeType since IE invents document fragments.
            (parent = copiedListItem.parentNode) && parent.nodeType === 1;

          ) {
            copiedListItem = parent;
          }
          // Put it on the list of lines for later processing.
          listItems.push(copiedListItem);
        }

        // Split lines while there are lines left to split.
        for (
          var i = 0; // Number of lines that have been split so far.
          i < listItems.length; // length updated by breakAfter calls.
          ++i
        ) {
          walk(listItems[i]);
        }

        // Make sure numeric indices show correctly.
        if (startLineNum === (startLineNum | 0)) {
          listItems[0].setAttribute('value', startLineNum);
        }

        const ol = document.createElement('ol');
        ol.className = 'linenums';
        const offset =
          Math.max(0, (startLineNum - 1) /* zero index */ | 0) || 0;
        for (const i = 0, n = listItems.length; i < n; ++i) {
          li = listItems[i];
          // Stick a class on the LIs so that stylesheets can
          // color odd/even rows, or any other row pattern that
          // is co-prime with 10.
          li.className = 'L' + ((i + offset) % 10);
          if (!li.firstChild) {
            li.appendChild(document.createTextNode('\xA0'));
          }
          ol.appendChild(li);
        }

        node.appendChild(ol);
      }

      /**
       * Breaks {@code job.sourceCode} around style boundaries in
       * {@code job.decorations} and modifies {@code job.sourceNode} in place.
       * @param {JobT} job
       * @private
       */
      function recombineTagsAndDecorations(job) {
        let isIE8OrEarlier = /\bMSIE\s(\d+)/.exec(navigator.userAgent);
        isIE8OrEarlier = isIE8OrEarlier && +isIE8OrEarlier[1] <= 8;
        const newlineRe = /\n/g;

        const source = job.sourceCode;
        const sourceLength = source.length;
        // Index into source after the last code-unit recombined.
        let sourceIndex = 0;

        const spans = job.spans;
        const nSpans = spans.length;
        // Index into spans after the last span which ends at or before sourceIndex.
        let spanIndex = 0;

        const decorations = job.decorations;
        let nDecorations = decorations.length;
        // Index into decorations after the last decoration which ends at or before
        // sourceIndex.
        let decorationIndex = 0;

        // Remove all zero-length decorations.
        decorations[nDecorations] = sourceLength;
        let decPos, i;
        for (i = decPos = 0; i < nDecorations; ) {
          if (decorations[i] !== decorations[i + 2]) {
            decorations[decPos++] = decorations[i++];
            decorations[decPos++] = decorations[i++];
          } else {
            i += 2;
          }
        }
        nDecorations = decPos;

        // Simplify decorations.
        for (i = decPos = 0; i < nDecorations; ) {
          const startPos = decorations[i];
          // Conflate all adjacent decorations that use the same style.
          const startDec = decorations[i + 1];
          var end = i + 2;
          while (end + 2 <= nDecorations && decorations[end + 1] === startDec) {
            end += 2;
          }
          decorations[decPos++] = startPos;
          decorations[decPos++] = startDec;
          i = end;
        }

        nDecorations = decorations.length = decPos;

        const sourceNode = job.sourceNode;
        let oldDisplay = '';
        if (sourceNode) {
          oldDisplay = sourceNode.style.display;
          sourceNode.style.display = 'none';
        }
        try {
          const decoration = null;
          while (spanIndex < nSpans) {
            const spanStart = spans[spanIndex];
            const spanEnd =
              /** @type{number} */ (spans[spanIndex + 2]) || sourceLength;

            const decEnd = decorations[decorationIndex + 2] || sourceLength;

            var end = Math.min(spanEnd, decEnd);

            let textNode = /** @type{Node} */ (spans[spanIndex + 1]);
            let styledText;
            if (
              textNode.nodeType !== 1 && // Don't muck with <BR>s or <LI>s
              // Don't introduce spans around empty text nodes.
              (styledText = source.substring(sourceIndex, end))
            ) {
              // This may seem bizarre, and it is.  Emitting LF on IE causes the
              // code to display with spaces instead of line breaks.
              // Emitting Windows standard issue linebreaks (CRLF) causes a blank
              // space to appear at the beginning of every line but the first.
              // Emitting an old Mac OS 9 line separator makes everything spiffy.
              if (isIE8OrEarlier) {
                styledText = styledText.replace(newlineRe, '\r');
              }
              textNode.nodeValue = styledText;
              const document = textNode.ownerDocument;
              const span = document.createElement('span');
              span.className = decorations[decorationIndex + 1];
              const parentNode = textNode.parentNode;
              parentNode.replaceChild(span, textNode);
              span.appendChild(textNode);
              if (sourceIndex < spanEnd) {
                // Split off a text node.
                spans[spanIndex + 1] = textNode =
                  // TODO: Possibly optimize by using '' if there's no flicker.
                  document.createTextNode(source.substring(end, spanEnd));
                parentNode.insertBefore(textNode, span.nextSibling);
              }
            }

            sourceIndex = end;

            if (sourceIndex >= spanEnd) {
              spanIndex += 2;
            }
            if (sourceIndex >= decEnd) {
              decorationIndex += 2;
            }
          }
        } finally {
          if (sourceNode) {
            sourceNode.style.display = oldDisplay;
          }
        }
      }

      /** Maps language-specific file extensions to handlers. */
      const langHandlerRegistry = {};
      /** Register a language handler for the given file extensions.
       * @param {function (JobT)} handler a function from source code to a list
       *      of decorations.  Takes a single argument job which describes the
       *      state of the computation and attaches the decorations to it.
       * @param {Array.<string>} fileExtensions
       */
      function registerLangHandler(handler, fileExtensions) {
        for (let i = fileExtensions.length; --i >= 0; ) {
          const ext = fileExtensions[i];
          if (!langHandlerRegistry.hasOwnProperty(ext)) {
            langHandlerRegistry[ext] = handler;
          } else if (win['console']) {
            console['warn']('cannot override language handler %s', ext);
          }
        }
      }
      function langHandlerForExtension(extension, source) {
        if (!(extension && langHandlerRegistry.hasOwnProperty(extension))) {
          // Treat it as markup if the first non whitespace character is a < and
          // the last non-whitespace character is a >.
          extension = /^\s*</.test(source) ? 'default-markup' : 'default-code';
        }
        return langHandlerRegistry[extension];
      }
      registerLangHandler(decorateSource, ['default-code']);
      registerLangHandler(
        createSimpleLexer(
          [],
          [
            [PR_PLAIN, /^[^<?]+/],
            [PR_DECLARATION, /^<!\w[^>]*(?:>|$)/],
            [PR_COMMENT, /^<\!--[\s\S]*?(?:-\->|$)/],
            // Unescaped content in an unknown language
            ['lang-', /^<\?([\s\S]+?)(?:\?>|$)/],
            ['lang-', /^<%([\s\S]+?)(?:%>|$)/],
            [PR_PUNCTUATION, /^(?:<[%?]|[%?]>)/],
            ['lang-', /^<xmp\b[^>]*>([\s\S]+?)<\/xmp\b[^>]*>/i],
            // Unescaped content in javascript.  (Or possibly vbscript).
            ['lang-js', /^<script\b[^>]*>([\s\S]*?)(<\/script\b[^>]*>)/i],
            // Contains unescaped stylesheet content
            ['lang-css', /^<style\b[^>]*>([\s\S]*?)(<\/style\b[^>]*>)/i],
            ['lang-in.tag', /^(<\/?[a-z][^<>]*>)/i],
          ]
        ),
        ['default-markup', 'htm', 'html', 'mxml', 'xhtml', 'xml', 'xsl']
      );
      registerLangHandler(
        createSimpleLexer(
          [
            [PR_PLAIN, /^[\s]+/, null, ' \t\r\n'],
            [PR_ATTRIB_VALUE, /^(?:\"[^\"]*\"?|\'[^\']*\'?)/, null, '"\''],
          ],
          [
            [PR_TAG, /^^<\/?[a-z](?:[\w.:-]*\w)?|\/?>$/i],
            [PR_ATTRIB_NAME, /^(?!style[\s=]|on)[a-z](?:[\w:-]*\w)?/i],
            ['lang-uq.val', /^=\s*([^>\'\"\s]*(?:[^>\'\"\s\/]|\/(?=\s)))/],
            [PR_PUNCTUATION, /^[=<>\/]+/],
            ['lang-js', /^on\w+\s*=\s*\"([^\"]+)\"/i],
            ['lang-js', /^on\w+\s*=\s*\'([^\']+)\'/i],
            ['lang-js', /^on\w+\s*=\s*([^\"\'>\s]+)/i],
            ['lang-css', /^style\s*=\s*\"([^\"]+)\"/i],
            ['lang-css', /^style\s*=\s*\'([^\']+)\'/i],
            ['lang-css', /^style\s*=\s*([^\"\'>\s]+)/i],
          ]
        ),
        ['in.tag']
      );
      registerLangHandler(
        createSimpleLexer([], [[PR_ATTRIB_VALUE, /^[\s\S]+/]]),
        ['uq.val']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: CPP_KEYWORDS,
          hashComments: true,
          cStyleComments: true,
          types: C_TYPES,
        }),
        ['c', 'cc', 'cpp', 'cxx', 'cyc', 'm']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: 'null,true,false',
        }),
        ['json']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: CSHARP_KEYWORDS,
          hashComments: true,
          cStyleComments: true,
          verbatimStrings: true,
          types: C_TYPES,
        }),
        ['cs']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: JAVA_KEYWORDS,
          cStyleComments: true,
        }),
        ['java']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: SH_KEYWORDS,
          hashComments: true,
          multiLineStrings: true,
        }),
        ['bash', 'bsh', 'csh', 'sh']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: PYTHON_KEYWORDS,
          hashComments: true,
          multiLineStrings: true,
          tripleQuotedStrings: true,
        }),
        ['cv', 'py', 'python']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: PERL_KEYWORDS,
          hashComments: true,
          multiLineStrings: true,
          regexLiterals: 2, // multiline regex literals
        }),
        ['perl', 'pl', 'pm']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: RUBY_KEYWORDS,
          hashComments: true,
          multiLineStrings: true,
          regexLiterals: true,
        }),
        ['rb', 'ruby']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: JSCRIPT_KEYWORDS,
          cStyleComments: true,
          regexLiterals: true,
        }),
        ['javascript', 'js', 'ts', 'typescript']
      );
      registerLangHandler(
        sourceDecorator({
          keywords: COFFEE_KEYWORDS,
          hashComments: 3, // ### style block comments
          cStyleComments: true,
          multilineStrings: true,
          tripleQuotedStrings: true,
          regexLiterals: true,
        }),
        ['coffee']
      );
      registerLangHandler(createSimpleLexer([], [[PR_STRING, /^[\s\S]+/]]), [
        'regex',
      ]);

      /** @param {JobT} job */
      function applyDecorator(job) {
        const opt_langExtension = job.langExtension;

        try {
          // Extract tags, and convert the source code to plain text.
          const sourceAndSpans = extractSourceSpans(job.sourceNode, job.pre);
          /** Plain text. @type {string} */
          const source = sourceAndSpans.sourceCode;
          job.sourceCode = source;
          job.spans = sourceAndSpans.spans;
          job.basePos = 0;

          // Apply the appropriate language handler
          langHandlerForExtension(opt_langExtension, source)(job);

          // Integrate the decorations and tags back into the source code,
          // modifying the sourceNode in place.
          recombineTagsAndDecorations(job);
        } catch (e) {
          if (win['console']) {
            console['log']((e && e['stack']) || e);
          }
        }
      }

      /**
       * Pretty print a chunk of code.
       * @param sourceCodeHtml {string} The HTML to pretty print.
       * @param opt_langExtension {string} The language name to use.
       *     Typically, a filename extension like 'cpp' or 'java'.
       * @param opt_numberLines {number|boolean} True to number lines,
       *     or the 1-indexed number of the first line in sourceCodeHtml.
       */
      function $prettyPrintOne(
        sourceCodeHtml,
        opt_langExtension,
        opt_numberLines
      ) {
        /** @type{number|boolean} */
        const nl = opt_numberLines || false;
        /** @type{string|null} */
        const langExtension = opt_langExtension || null;
        /** @type{!Element} */
        let container = document.createElement('div');
        // This could cause images to load and onload listeners to fire.
        // E.g. <img onerror="alert(1337)" src="nosuchimage.png">.
        // We assume that the inner HTML is from a trusted source.
        // The pre-tag is required for IE8 which strips newlines from innerHTML
        // when it is injected into a <pre> tag.
        // http://stackoverflow.com/questions/451486/pre-tag-loses-line-breaks-when-setting-innerhtml-in-ie
        // http://stackoverflow.com/questions/195363/inserting-a-newline-into-a-pre-tag-ie-javascript
        container.innerHTML = '<pre>' + sourceCodeHtml + '</pre>';
        container = /** @type{!Element} */ (container.firstChild);
        if (nl) {
          numberLines(container, nl, true);
        }

        /** @type{JobT} */
        const job = {
          langExtension: langExtension,
          numberLines: nl,
          sourceNode: container,
          pre: 1,
          sourceCode: null,
          basePos: null,
          spans: null,
          decorations: null,
        };
        applyDecorator(job);
        return container.innerHTML;
      }

      /**
       * Find all the {@code <pre>} and {@code <code>} tags in the DOM with
       * {@code class=prettyprint} and prettify them.
       *
       * @param {Function} opt_whenDone called when prettifying is done.
       * @param {HTMLElement|HTMLDocument} opt_root an element or document
       *   containing all the elements to pretty print.
       *   Defaults to {@code document.body}.
       */
      function $prettyPrint(opt_whenDone, opt_root) {
        const root = opt_root || document.body;
        const doc = root.ownerDocument || document;
        function byTagName(tn) {
          return root.getElementsByTagName(tn);
        }
        // fetch a list of nodes to rewrite
        let codeSegments = [
          byTagName('pre'),
          byTagName('code'),
          byTagName('xmp'),
        ];
        const elements = [];
        for (let i = 0; i < codeSegments.length; ++i) {
          for (let j = 0, n = codeSegments[i].length; j < n; ++j) {
            elements.push(codeSegments[i][j]);
          }
        }
        codeSegments = null;

        let clock = Date;
        if (!clock['now']) {
          clock = {
            now() {
              return +new Date();
            },
          };
        }

        // The loop is broken into a series of continuations to make sure that we
        // don't make the browser unresponsive when rewriting a large page.
        let k = 0;

        const langExtensionRe = /\blang(?:uage)?-([\w.]+)(?!\S)/;
        const prettyPrintRe = /\bprettyprint\b/;
        const prettyPrintedRe = /\bprettyprinted\b/;
        const preformattedTagNameRe = /pre|xmp/i;
        const codeRe = /^code$/i;
        const preCodeXmpRe = /^(?:pre|code|xmp)$/i;
        const EMPTY = {};

        function doWork() {
          const endTime = win['PR_SHOULD_USE_CONTINUATION']
            ? clock['now']() + 250 /* ms */
            : Infinity;
          for (; k < elements.length && clock['now']() < endTime; k++) {
            const cs = elements[k];

            // Look for a preceding comment like
            // <?prettify lang="..." linenums="..."?>
            let attrs = EMPTY;
            {
              for (let preceder = cs; (preceder = preceder.previousSibling); ) {
                const nt = preceder.nodeType;
                // <?foo?> is parsed by HTML 5 to a comment node (8)
                // like <!--?foo?-->, but in XML is a processing instruction
                const value = (nt === 7 || nt === 8) && preceder.nodeValue;
                if (
                  value
                    ? !/^\??prettify\b/.test(value)
                    : nt !== 3 || /\S/.test(preceder.nodeValue)
                ) {
                  // Skip over white-space text nodes but not others.
                  break;
                }
                if (value) {
                  attrs = {};
                  value.replace(/\b(\w+)=([\w:.%+-]+)/g, (_, name, value) => {
                    attrs[name] = value;
                  });
                  break;
                }
              }
            }

            const className = cs.className;
            if (
              (attrs !== EMPTY || prettyPrintRe.test(className)) &&
              // Don't redo this if we've already done it.
              // This allows recalling pretty print to just prettyprint elements
              // that have been added to the page since last call.
              !prettyPrintedRe.test(className)
            ) {
              // make sure this is not nested in an already prettified element
              let nested = false;
              for (let p = cs.parentNode; p; p = p.parentNode) {
                const tn = p.tagName;
                if (
                  preCodeXmpRe.test(tn) &&
                  p.className &&
                  prettyPrintRe.test(p.className)
                ) {
                  nested = true;
                  break;
                }
              }
              if (!nested) {
                // Mark done.  If we fail to prettyprint for whatever reason,
                // we shouldn't try again.
                cs.className += ' prettyprinted';

                // If the classes includes a language extensions, use it.
                // Language extensions can be specified like
                //     <pre class="prettyprint lang-cpp">
                // the language extension "cpp" is used to find a language handler
                // as passed to PR.registerLangHandler.
                // HTML5 recommends that a language be specified using "language-"
                // as the prefix instead.  Google Code Prettify supports both.
                // http://dev.w3.org/html5/spec-author-view/the-code-element.html
                let langExtension = attrs['lang'];
                if (!langExtension) {
                  langExtension = className.match(langExtensionRe);
                  // Support <pre class="prettyprint"><code class="language-c">
                  let wrapper;
                  if (
                    !langExtension &&
                    (wrapper = childContentWrapper(cs)) &&
                    codeRe.test(wrapper.tagName)
                  ) {
                    langExtension = wrapper.className.match(langExtensionRe);
                  }

                  if (langExtension) {
                    langExtension = langExtension[1];
                  }
                }

                let preformatted;
                if (preformattedTagNameRe.test(cs.tagName)) {
                  preformatted = 1;
                } else {
                  const currentStyle = cs['currentStyle'];
                  const defaultView = doc.defaultView;
                  const whitespace = currentStyle
                    ? currentStyle['whiteSpace']
                    : defaultView && defaultView.getComputedStyle
                    ? defaultView
                        .getComputedStyle(cs, null)
                        .getPropertyValue('white-space')
                    : 0;
                  preformatted =
                    whitespace && 'pre' === whitespace.substring(0, 3);
                }

                // Look for a class like linenums or linenums:<n> where <n> is the
                // 1-indexed number of the first line.
                let lineNums = attrs['linenums'];
                if (!(lineNums = lineNums === 'true' || +lineNums)) {
                  lineNums = className.match(/\blinenums\b(?::(\d+))?/);
                  lineNums = lineNums
                    ? lineNums[1] && lineNums[1].length
                      ? +lineNums[1]
                      : true
                    : false;
                }
                if (lineNums) {
                  numberLines(cs, lineNums, preformatted);
                }

                // do the pretty printing
                const prettyPrintingJob = {
                  langExtension: langExtension,
                  sourceNode: cs,
                  numberLines: lineNums,
                  pre: preformatted,
                  sourceCode: null,
                  basePos: null,
                  spans: null,
                  decorations: null,
                };
                applyDecorator(prettyPrintingJob);
              }
            }
          }
          if (k < elements.length) {
            // finish up in a continuation
            win.setTimeout(doWork, 250);
          } else if ('function' === typeof opt_whenDone) {
            opt_whenDone();
          }
        }

        doWork();
      }

      /**
       * Contains functions for creating and registering new language handlers.
       * @type {Object}
       */
      const PR = (win['PR'] = {
        createSimpleLexer: createSimpleLexer,
        registerLangHandler: registerLangHandler,
        sourceDecorator: sourceDecorator,
        PR_ATTRIB_NAME: PR_ATTRIB_NAME,
        PR_ATTRIB_VALUE: PR_ATTRIB_VALUE,
        PR_COMMENT: PR_COMMENT,
        PR_DECLARATION: PR_DECLARATION,
        PR_KEYWORD: PR_KEYWORD,
        PR_LITERAL: PR_LITERAL,
        PR_NOCODE: PR_NOCODE,
        PR_PLAIN: PR_PLAIN,
        PR_PUNCTUATION: PR_PUNCTUATION,
        PR_SOURCE: PR_SOURCE,
        PR_STRING: PR_STRING,
        PR_TAG: PR_TAG,
        PR_TYPE: PR_TYPE,
        prettyPrintOne: IN_GLOBAL_SCOPE
          ? (win['prettyPrintOne'] = $prettyPrintOne)
          : (prettyPrintOne = $prettyPrintOne),
        prettyPrint: (prettyPrint = IN_GLOBAL_SCOPE
          ? (win['prettyPrint'] = $prettyPrint)
          : (prettyPrint = $prettyPrint)),
      });

      // Make PR available via the Asynchronous Module Definition (AMD) API.
      // Per https://github.com/amdjs/amdjs-api/wiki/AMD:
      // The Asynchronous Module Definition (AMD) API specifies a
      // mechanism for defining modules such that the module and its
      // dependencies can be asynchronously loaded.
      // ...
      // To allow a clear indicator that a global define function (as
      // needed for script src browser loading) conforms to the AMD API,
      // any global define function SHOULD have a property called "amd"
      // whose value is an object. This helps avoid conflict with any
      // other existing JavaScript code that could have defined a define()
      // function that does not conform to the AMD API.
      const define = win['define'];
      if (typeof define === 'function' && define['amd']) {
        define('google-code-prettify', [], () => {
          return PR;
        });
      }
    })();
    return prettyPrint;
  })();

  // If this script is deferred or async and the document is already
  // loaded we need to wait for language handlers to load before performing
  // any autorun.
  function onLangsLoaded() {
    if (autorun) {
      contentLoaded(() => {
        const n = callbacks.length;
        const callback = n
          ? () => {
              for (let i = 0; i < n; ++i) {
                ((i) => {
                  win.setTimeout(function () {
                    win['exports'][callbacks[i]].apply(win, arguments);
                  }, 0);
                })(i);
              }
            }
          : void 0;
        prettyPrint(callback);
      });
    }
  }
  checkPendingLanguages();
})();
