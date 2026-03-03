(function() {
  var highlightAttempts = 0;
  var pendingChunk = null;

  console.log('[chunk-hl] loaded');

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

  function stripMd(text) {
    return text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')           // images
      .replace(/\[([^\]]*)\]\([^)]*(?:\s+"[^"]*")?\)/g, '$1') // links with optional title
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\|/g, ' ')
      .replace(/---+/g, '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Extract Chinese phrases (>=6 chars) from text
  function extractAnchors(text) {
    var phrases = [];
    var re = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef，。、；：""''（）]+/g;
    var m;
    while (m = re.exec(text)) {
      if (m[0].length >= 6) phrases.push(m[0]);
    }
    return phrases;
  }

  function findBestContainer() {
    var best = null, bestLen = 0;
    var els = document.querySelectorAll('div, section, article');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var len = (el.textContent || '').length;
      if (len > bestLen && len > 1000) {
        var cls = (el.className || '') + ' ' + (el.getAttribute('style') || '');
        if (cls.match(/prose|markdown|content|overflow|scroll|tab/) || el.scrollHeight > el.clientHeight + 50) {
          bestLen = len; best = el;
        }
      }
    }
    return best;
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

    // Find all text nodes that overlap [startIdx, endIdx]
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

    // Scroll to first highlight
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

  async function tryHighlight() {
    if (!pendingChunk) return;
    highlightAttempts++;
    if (highlightAttempts > 10) { pendingChunk = null; return; }

    var container = findBestContainer();
    if (!container) { console.log('[chunk-hl] #' + highlightAttempts + ' no container'); return; }

    if (!pendingChunk.content) {
      try {
        var resp = await fetch('/api/sources/' + pendingChunk.sourceId + '/chunks/' + pendingChunk.chunkOrder);
        if (!resp.ok) return;
        var data = await resp.json();
        pendingChunk.content = data.content;
        console.log('[chunk-hl] fetched chunk, len=' + data.content.length);
      } catch(e) { return; }
    }

    var clean = stripMd(pendingChunk.content);
    var anchors = extractAnchors(clean);
    var textMap = getTextMap(container);
    var ft = textMap.fullText;

    console.log('[chunk-hl] #' + highlightAttempts + ' container=' + ft.length + 'c, anchors=' + anchors.length);

    // Try to find anchor phrases in DOM text, prefer longer ones from middle
    var midAnchors = anchors.slice(Math.floor(anchors.length * 0.2), Math.floor(anchors.length * 0.8));
    var allAnchors = midAnchors.concat(anchors);

    var foundPos = -1;
    var foundPhrase = '';
    for (var i = 0; i < allAnchors.length; i++) {
      var phrase = allAnchors[i];
      if (phrase.length < 6) continue;
      var searchStr = phrase.substring(0, Math.min(20, phrase.length));
      var idx = ft.indexOf(searchStr);
      if (idx >= 0) {
        foundPos = idx;
        foundPhrase = searchStr;
        console.log('[chunk-hl] anchor found: "' + searchStr.substring(0,15) + '..." at pos ' + idx);
        break;
      }
    }

    if (foundPos < 0) {
      // Fallback: try first 15 chars of cleaned content
      var firstChars = clean.replace(/\s/g, '').substring(0, 15);
      var ftNoSpace = ft.replace(/\s/g, '');
      var fIdx = ftNoSpace.indexOf(firstChars);
      if (fIdx >= 0) {
        // Map back to original position (approximate)
        foundPos = Math.round(fIdx * ft.length / ftNoSpace.length);
        foundPhrase = firstChars;
        console.log('[chunk-hl] fallback found: "' + firstChars.substring(0,10) + '..." at ~pos ' + foundPos);
      }
    }

    if (foundPos < 0) {
      console.log('[chunk-hl] no match, clean starts with: "' + clean.substring(0, 40) + '"');
      return;
    }

    // Estimate chunk boundaries: the clean text length approximates the DOM text span
    var chunkTextLen = clean.length;
    // The found phrase is somewhere in the chunk; estimate where chunk starts
    var phraseOffsetInChunk = clean.indexOf(foundPhrase);
    if (phraseOffsetInChunk < 0) phraseOffsetInChunk = 0;

    var estimatedStart = foundPos - phraseOffsetInChunk;
    var estimatedEnd = estimatedStart + chunkTextLen;

    // Clamp to valid range
    estimatedStart = Math.max(0, estimatedStart - 20);
    estimatedEnd = Math.min(ft.length, estimatedEnd + 20);

    console.log('[chunk-hl] highlight range: ' + estimatedStart + '-' + estimatedEnd + ' (' + (estimatedEnd - estimatedStart) + ' chars)');

    if (highlightRange(container, textMap, estimatedStart, estimatedEnd)) {
      pendingChunk = null;
      highlightAttempts = 0;
    }
  }
})();
