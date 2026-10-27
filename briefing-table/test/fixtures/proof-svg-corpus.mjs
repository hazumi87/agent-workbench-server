/** Inert strings until injected into the isolated browser proof; no external URLs. */
export const svgCorpus = [
  { name: 'foreignObject-srcdoc', svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="100"><iframe xmlns="http://www.w3.org/1999/xhtml" srcdoc="&lt;script&gt;parent.__proofXss++&lt;/script&gt;"></iframe></foreignObject></svg>' },
  { name: 'javascript-link', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><a href="javascript:window.__proofXss++"><text x="1" y="20">activate</text></a></svg>' },
  { name: 'xlink-javascript', svg: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="50"><a xlink:href="javascript:window.__proofXss++"><text x="1" y="20">activate</text></a></svg>' },
  { name: 'entity-obfuscated-link', svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><a href="java&#x73;cript:window.__proofXss++"><text x="1" y="20">activate</text></a></svg>' },
  { name: 'svg-load-event', svg: '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__proofXss++"><path d="M0 0L1 1"/></svg>' },
  { name: 'html-image-event', svg: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="100" height="100"><img xmlns="http://www.w3.org/1999/xhtml" src="data:image/png,invalid" onerror="window.__proofXss++"/></foreignObject></svg>' },
];
export const benignSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0L10 10"/></svg>';
