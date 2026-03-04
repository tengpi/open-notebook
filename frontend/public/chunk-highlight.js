(function() {
  var highlightAttempts = 0;
  var pendingChunk = null;

  console.log('[chunk-hl] loaded v2');

  // --- Trigger: click on reference button ---
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    var text = btn.textContent || '';
    var match = text.match(/source:([a-zA-Z0-9_]+)#chunk:(\d+)/);
    if (match) {
      console.log('[chunk-hl] click: chunk=' + match[2]);
      pendingChunk = { sourceId: match[1], chunkOrder: parseInt(match[2]), content: null };
      highlightAttempts = 0;
      scheduleHighlight();
    }
  }, true);

  // --- Trigger: sessionStorage from modal system ---
  setInterval(function() {
    if (pendingChunk) return;
    try {
      var raw = sessionStorage.getItem('highlight_chunk');
      if (!raw) return;
      var info = JSON.parse(raw);
      if (info.sourceId && info.chunkOrder !== undefined) {
        pendingChunk = { sourceId: info.sourceId, chunkOrder: info.chunkOrder, content: null };
        highlightAttempts = 0;
        sessionStorage.removeItem('highlight_chunk');
        scheduleHighlight();
      }
    } catch(e) {}
  }, 500);

  function scheduleHighlight() {
    [1000, 2000, 3500, 5000, 7000].forEach(function(d) { setTimeout(tryHighlight, d); });
  }

  // =========================================================================
  // Text normalization — applied to BOTH chunk markdown and DOM text
  // so they meet in a common "plain text" space for matching.
  // =========================================================================
  function normalizeText(text) {
    return text
      // Remove markdown images ![alt](url)
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // Remove markdown links [text](url) — keep text
      .replace(/\[([^\]]*)\]\([^)]*(?:\s+"[^"]*")?\)/g, '$1')
      // Remove bold/italic markers (*** ** * ___ __ _)
      .replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1')
      .replace(/_{1,3}([^_]*)_{1,3}/g, '$1')
      // Remove inline code backticks
      .replace(/`([^`]*)`/g, '$1')
      // Remove heading markers
      .replace(/^#{1,6}\s*/gm, '')
      // Remove reference markers like [2,8] [1] [2-4] [1,2,3]
      .replace(/\[[\d,\s\-–]+\]/g, '')
      // Remove table pipes and separator rows
      .replace(/\|/g, ' ')
      .replace(/^[\s\-:|]+$/gm, '')
      // Remove horizontal rules
      .replace(/^---+$/gm, '')
      // Remove leading list markers: "1. " "- " "* "
      .replace(/^\s*(\d+\.\s+|[-*+]\s+)/gm, '')
      // Collapse whitespace
      .replace(/\s+/g, ' ')
      .trim();
  }

  // =========================================================================
  // Precise position mapping: normalized text ↔ original text
  // =========================================================================
  function buildNormMap(original) {
    var normalized = '';
    var toOriginal = [];
    var inWhitespace = false;
    for (var i = 0; i < original.length; i++) {
      var ch = original.charAt(i);
      if (/\s/.test(ch)) {
        if (!inWhitespace && normalized.length > 0) {
          normalized += ' ';
          toOriginal.push(i);
          inWhitespace = true;
        }
      } else {
        normalized += ch;
        toOriginal.push(i);
        inWhitespace = false;
      }
    }
    // Trim trailing space
    if (normalized.charAt(normalized.length - 1) === ' ') {
      normalized = normalized.slice(0, -1);
      toOriginal.pop();
    }
    return { normalized: normalized, toOriginal: toOriginal };
  }

  // =========================================================================
  // Anchor extraction — CJK then English
  // =========================================================================
  function extractCJKAnchors(text) {
    var phrases = [];
    var re = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\uff0c\u3002\u3001\uff1b\uff1a\u201c\u201d\u2018\u2019\uff08\uff09]+/g;
    var m;
    while (m = re.exec(text)) {
      if (m[0].length >= 6) phrases.push(m[0]);
    }
    return phrases;
  }

  function extractEnglishAnchors(text) {
    var anchors = [];
    var words = text.split(/\s+/).filter(function(w) { return w.length > 0; });

    // 4-word sliding window, step 2
    for (var i = 0; i < words.length - 3; i += 2) {
      var phrase = words.slice(i, i + 4).join(' ');
      // Skip if purely numeric/punctuation
      if (/^[\d\s.,;:()%°±=<>+\-\/]+$/.test(phrase)) continue;
      // Require at least one word with 4+ alpha chars (distinctive)
      if (/[a-zA-Z]{4,}/.test(phrase)) {
        anchors.push(phrase);
      }
    }

    // Prioritize middle anchors (more unique than start/end)
    var midStart = Math.floor(anchors.length * 0.25);
    var midEnd = Math.ceil(anchors.length * 0.75);
    var midAnchors = anchors.slice(midStart, midEnd);
    var edgeAnchors = anchors.slice(0, midStart).concat(anchors.slice(midEnd));
    return midAnchors.concat(edgeAnchors);
  }

  function extractAnchors(text) {
    var cjk = extractCJKAnchors(text);
    if (cjk.length > 0) return cjk;
    return extractEnglishAnchors(text);
  }

  // =========================================================================
  // Fuzzy sliding-window match
  // =========================================================================
  function slidingWindowMatch(needle, haystack, threshold) {
    var windowSize = Math.min(needle.length, 40);
    if (windowSize < 10) return -1;
    var needleSlice = needle.substring(0, windowSize).toLowerCase();
    var minMatch = Math.floor(windowSize * threshold);
    var bestPos = -1;
    var bestScore = minMatch - 1;

    for (var i = 0; i <= haystack.length - windowSize; i++) {
      var score = 0;
      for (var j = 0; j < windowSize; j++) {
        if (needleSlice.charAt(j) === haystack.charAt(i + j).toLowerCase()) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPos = i;
      }
    }
    return bestPos >= 0 && bestScore >= minMatch ? bestPos : -1;
  }

  // =========================================================================
  // DOM helpers (unchanged)
  // =========================================================================
  function findBestContainer() {
    // IMPORTANT: Only highlight inside source views (modal or detail page).
    // Never highlight inside the Ask answer area — that would highlight the
    // answer itself instead of the referenced source document.

    // Strategy 1: Source modal (dialog) — highest priority
    var dialogContent = document.querySelector('[data-slot="dialog-content"]');
    if (dialogContent) {
      var inner = dialogContent.querySelector('.prose') || dialogContent;
      if ((inner.textContent || '').length > 200) {
        console.log('[chunk-hl] container: dialog .prose (' + inner.textContent.length + 'c)');
        return inner;
      }
    }

    // Strategy 2: Source detail page at /sources/[id]
    if (window.location.pathname.match(/\/sources\//)) {
      var proseEl = document.querySelector('.prose');
      if (proseEl && (proseEl.textContent || '').length > 200) {
        console.log('[chunk-hl] container: source page .prose (' + proseEl.textContent.length + 'c)');
        return proseEl;
      }
    }

    // No valid source container found — return null to wait for modal to open
    console.log('[chunk-hl] no source container (waiting for modal)');
    return null;
  }

  function getTextMap(container) {
    var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
    var node, fullText = '', nodes = [];
    while (node = walker.nextNode()) {
      nodes.push({ node: node, start: fullText.length });
      fullText += node.textContent;
    }
    return { fullText: fullText, nodes: nodes };
  }

  function findScrollParent(el) {
    var p = el.parentElement;
    while (p) {
      var s = window.getComputedStyle(p);
      if ((s.overflow === 'auto' || s.overflow === 'scroll' || s.overflowY === 'auto' || s.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 50)
        return p;
      p = p.parentElement;
    }
    return null;
  }

  function highlightRange(container, textMap, startIdx, endIdx) {
    // Remove old highlights
    container.querySelectorAll('.chunk-highlight').forEach(function(el) {
      var p = el.parentNode;
      while (el.firstChild) p.insertBefore(el.firstChild, el);
      p.removeChild(el);
    });

    var highlighted = [];
    for (var i = 0; i < textMap.nodes.length; i++) {
      var tn = textMap.nodes[i];
      var nodeEnd = tn.start + tn.node.textContent.length;
      if (nodeEnd <= startIdx || tn.start >= endIdx) continue;

      var localStart = Math.max(0, startIdx - tn.start);
      var localEnd = Math.min(tn.node.textContent.length, endIdx - tn.start);
      if (localEnd <= localStart) continue;

      try {
        var mark = document.createElement('mark');
        mark.className = 'chunk-highlight';
        mark.style.cssText = 'background-color: #fef08a; padding: 1px 0; border-radius: 2px;';
        var range = document.createRange();
        range.setStart(tn.node, localStart);
        range.setEnd(tn.node, localEnd);
        range.surroundContents(mark);
        highlighted.push(mark);
      } catch(e) {}
    }

    if (highlighted.length > 0) {
      var first = highlighted[0];
      var sp = findScrollParent(first);
      if (sp) {
        var rect = first.getBoundingClientRect();
        var pRect = sp.getBoundingClientRect();
        var offset = rect.top - pRect.top + sp.scrollTop - (pRect.height / 4);
        sp.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      } else {
        first.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      console.log('[chunk-hl] Highlighted ' + highlighted.length + ' nodes');
      return true;
    }
    return false;
  }

  // =========================================================================
  // Main matching logic — 4-tier cascade
  // =========================================================================
  async function tryHighlight() {
    if (!pendingChunk) return;
    highlightAttempts++;
    if (highlightAttempts > 10) { pendingChunk = null; return; }

    var container = findBestContainer();
    if (!container) { console.log('[chunk-hl] #' + highlightAttempts + ' no container'); return; }

    // Fetch chunk content from API
    if (!pendingChunk.content) {
      try {
        var resp = await fetch('/api/sources/' + pendingChunk.sourceId + '/chunks/' + pendingChunk.chunkOrder);
        if (!resp.ok) return;
        var data = await resp.json();
        pendingChunk.content = data.content;
        console.log('[chunk-hl] fetched chunk, len=' + data.content.length);
      } catch(e) { return; }
    }

    // Normalize chunk content (markdown → plain)
    var normChunk = normalizeText(pendingChunk.content);

    // Build DOM text map and normalized DOM text with position mapping
    var textMap = getTextMap(container);
    var domText = textMap.fullText;
    var domMap = buildNormMap(domText);
    var normDom = domMap.normalized;

    console.log('[chunk-hl] #' + highlightAttempts + ' domLen=' + domText.length + ', normChunkLen=' + normChunk.length);

    var foundOrigPos = -1;    // position in original domText
    var foundInNorm = -1;     // position in normDom (for offset calc)
    var matchTier = '';

    // --- Tier 1: Direct substring from middle of normalized chunk ---
    var midOffset = Math.floor(normChunk.length * 0.3);
    var snippetLen = Math.min(35, normChunk.length - midOffset);
    if (snippetLen >= 15) {
      var snippet = normChunk.substring(midOffset, midOffset + snippetLen);
      var idx = normDom.indexOf(snippet);
      if (idx < 0) {
        // Try case-insensitive
        idx = normDom.toLowerCase().indexOf(snippet.toLowerCase());
      }
      if (idx >= 0) {
        foundInNorm = idx;
        foundOrigPos = domMap.toOriginal[idx] || 0;
        matchTier = 'T1-direct';
        console.log('[chunk-hl] T1 match: "' + snippet.substring(0, 25) + '..." at normPos=' + idx);
      }
    }

    // --- Tier 2: English/CJK anchor phrases ---
    if (foundOrigPos < 0) {
      var anchors = extractAnchors(normChunk);
      console.log('[chunk-hl] T2 anchors: ' + anchors.length);
      for (var i = 0; i < anchors.length && i < 30; i++) {
        var anchor = anchors[i];
        if (anchor.length < 8) continue;
        var searchStr = anchor.substring(0, Math.min(30, anchor.length));
        var aIdx = normDom.indexOf(searchStr);
        if (aIdx < 0) {
          aIdx = normDom.toLowerCase().indexOf(searchStr.toLowerCase());
        }
        if (aIdx >= 0) {
          foundInNorm = aIdx;
          foundOrigPos = domMap.toOriginal[aIdx] || 0;
          matchTier = 'T2-anchor';
          console.log('[chunk-hl] T2 match: "' + searchStr.substring(0, 20) + '..." at normPos=' + aIdx);
          break;
        }
      }
    }

    // --- Tier 3: Fuzzy sliding window ---
    if (foundOrigPos < 0) {
      // Try a few candidate snippets from different positions in the chunk
      var candidates = [];
      // From 30% into the chunk
      var c1Start = Math.floor(normChunk.length * 0.3);
      if (c1Start + 40 <= normChunk.length) candidates.push(normChunk.substring(c1Start, c1Start + 40));
      // From 50% into the chunk
      var c2Start = Math.floor(normChunk.length * 0.5);
      if (c2Start + 40 <= normChunk.length) candidates.push(normChunk.substring(c2Start, c2Start + 40));
      // From the start (skip first word which may be a number)
      var firstSpace = normChunk.indexOf(' ');
      if (firstSpace > 0 && firstSpace < 20) {
        var fromSecondWord = normChunk.substring(firstSpace + 1);
        if (fromSecondWord.length >= 30) candidates.push(fromSecondWord.substring(0, 40));
      }

      for (var ci = 0; ci < candidates.length; ci++) {
        var fIdx = slidingWindowMatch(candidates[ci], normDom, 0.70);
        if (fIdx >= 0) {
          foundInNorm = fIdx;
          foundOrigPos = domMap.toOriginal[fIdx] || 0;
          matchTier = 'T3-fuzzy';
          console.log('[chunk-hl] T3 match at normPos=' + fIdx + ' (candidate ' + ci + ')');
          break;
        }
      }
    }

    // --- Tier 4: Alphanumeric-only fallback ---
    if (foundOrigPos < 0) {
      var alphaChunk = normChunk.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').toLowerCase();
      var alphaDom = normDom.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').toLowerCase();
      // Try 40 chars from different positions
      var offsets = [0, Math.floor(alphaChunk.length * 0.3), Math.floor(alphaChunk.length * 0.5)];
      for (var oi = 0; oi < offsets.length; oi++) {
        var off = offsets[oi];
        var needle = alphaChunk.substring(off, off + 40);
        if (needle.length < 15) continue;
        var nIdx = alphaDom.indexOf(needle);
        if (nIdx >= 0) {
          // Approximate mapping back: ratio-based (acceptable for last resort)
          foundOrigPos = Math.round(nIdx * domText.length / alphaDom.length);
          foundInNorm = -1; // no precise mapping
          matchTier = 'T4-alpha';
          console.log('[chunk-hl] T4 match: "' + needle.substring(0, 20) + '..." at ~pos ' + foundOrigPos);
          break;
        }
      }
    }

    // --- No match ---
    if (foundOrigPos < 0) {
      console.log('[chunk-hl] no match, normChunk starts: "' + normChunk.substring(0, 50) + '"');
      return;
    }

    // =========================================================================
    // Estimate chunk boundaries in original DOM text
    // =========================================================================
    // Scale normalized chunk length to approximate DOM text span
    var lengthRatio = domText.length / (normDom.length || 1);
    var estimatedSpan = Math.round(normChunk.length * lengthRatio);

    var estimatedStart, estimatedEnd;

    if (foundInNorm >= 0 && matchTier !== 'T4-alpha') {
      // We know where in normDom we matched; figure out chunk start
      // The match position in normDom corresponds to some offset within the chunk
      var matchedSnippet = '';
      if (matchTier === 'T1-direct') {
        // We matched from 30% into normChunk
        var phraseOffsetInChunk = Math.floor(normChunk.length * 0.3);
        var chunkStartInNorm = foundInNorm - phraseOffsetInChunk;
        estimatedStart = domMap.toOriginal[Math.max(0, chunkStartInNorm)] || 0;
      } else if (matchTier === 'T2-anchor') {
        // Find where the matched anchor is in the normalized chunk
        var anchorInChunk = normChunk.indexOf(normDom.substring(foundInNorm, foundInNorm + 20));
        if (anchorInChunk < 0) anchorInChunk = Math.floor(normChunk.length * 0.3);
        var chunkStartInNorm2 = foundInNorm - anchorInChunk;
        estimatedStart = domMap.toOriginal[Math.max(0, chunkStartInNorm2)] || 0;
      } else {
        // T3-fuzzy: similar logic
        var fuzzyOffsetInChunk = Math.floor(normChunk.length * 0.3); // candidates[0] starts at 30%
        var chunkStartInNorm3 = foundInNorm - fuzzyOffsetInChunk;
        estimatedStart = domMap.toOriginal[Math.max(0, chunkStartInNorm3)] || 0;
      }
      estimatedEnd = estimatedStart + estimatedSpan;
    } else {
      // T4: ratio-based
      estimatedStart = foundOrigPos;
      estimatedEnd = estimatedStart + estimatedSpan;
    }

    // Clamp with small buffer
    estimatedStart = Math.max(0, estimatedStart - 10);
    estimatedEnd = Math.min(domText.length, estimatedEnd + 10);

    console.log('[chunk-hl] ' + matchTier + ' range: ' + estimatedStart + '-' + estimatedEnd + ' (' + (estimatedEnd - estimatedStart) + ' chars)');

    if (highlightRange(container, textMap, estimatedStart, estimatedEnd)) {
      pendingChunk = null;
      highlightAttempts = 0;
    }
  }
})();
