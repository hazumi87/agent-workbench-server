import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset } from '../types';

const BASE = '/asset-management/library';
const PAGE = 200;

// What the Library section shows. The server filters, sorts and pages — the library can
// hold tens of thousands of rows (the Midjourney archive alone is 20k), so nothing is
// filtered client-side. `excludedSources` hides sources (all shown by default).
export interface LibraryQuery {
  q: string;
  sort: 'newest' | 'oldest' | 'alpha';
  excludedSources: string[];
  categories: string[];   // empty = all
  collections: string[];  // picked asset packs; empty = none (packs stay out of the default view)
  subtypes: string[];     // checked sub-filters as "category/subtype" keys ("clip" exists under audio, image AND video)
}

export interface Facets {
  sources: { source: string; count: number }[];
  categories: { category: string; count: number }[];
  subtypes?: { category: string; subtype: string; count: number }[];
  collections: { slug: string; name: string; kind: string; count: number }[];
}

export interface LibraryControls {
  query: LibraryQuery;
  setQuery: (q: LibraryQuery) => void;
  total: number;
  loadMore: () => void;
  loadingMore: boolean;
  facets: Facets | null;
}

interface LibraryData {
  clipboardAssets: Asset[];
  recycleAssets: Asset[];
  favoriteAssets: Asset[];
  setFavoriteAssets: (f: (prev: Asset[]) => Asset[]) => void;
  libraryAssets: Asset[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  library: LibraryControls;
}

export const subKey = (category: string, subtype: string) => `${category}/${subtype}`;
/** The sub-filters checked under one type. */
export const checkedSubs = (query: LibraryQuery, category: string) =>
  query.subtypes.filter(k => k.startsWith(category + '/')).map(k => k.slice(category.length + 1));

function libraryUrl(query: LibraryQuery, facets: Facets | null, offset: number): string {
  const p = new URLSearchParams({ transient: '0', limit: String(PAGE), offset: String(offset), sort: query.sort });
  if (query.q.trim()) p.set('q', query.q.trim());
  if (query.categories.length) p.set('category', query.categories.join(','));
  // Only the types that have checked subs are narrowed — sent as category/subtype pairs, so the
  // server never lets one type's sub-filter touch another type (e.g. audio "voice" vs video "clip").
  const pairs = query.categories.flatMap(c => checkedSubs(query, c).map(s => subKey(c, s)));
  if (pairs.length) p.set('subtype', pairs.join(','));
  if (query.collections.length) p.set('collection', query.collections.join(','));
  else if (query.excludedSources.length && facets) {
    // The API takes an include list; send every known source that isn't excluded.
    const shown = facets.sources.map(s => s.source).filter(s => !query.excludedSources.includes(s));
    p.set('source', shown.length ? shown.join(',') : '__none__');
  }
  return `${BASE}/api/assets?${p}`;
}

// Fetch the first `want` items of a query, in API-sized chunks (the endpoint caps limit at 1000).
async function fetchRange(query: LibraryQuery, facets: Facets | null, want: number): Promise<{ assets: Asset[]; total: number }> {
  const out: Asset[] = [];
  let total = 0;
  while (out.length < want) {
    const n = Math.min(1000, want - out.length);
    const u = new URL(libraryUrl(query, facets, out.length), location.origin);
    u.searchParams.set('limit', String(n));
    const res = await fetch(u).then(r => r.json());
    total = res.total ?? 0;
    const got: Asset[] = res.assets ?? [];
    out.push(...got);
    if (got.length < n) break;
  }
  return { assets: out, total };
}

export function useLibraryData(): LibraryData {
  const [clipboardAssets, setClipboard] = useState<Asset[]>([]);
  const [recycleAssets, setRecycle] = useState<Asset[]>([]);
  const [favoriteAssets, setFavoriteAssets] = useState<Asset[]>([]);
  const [libraryAssets, setLibrary] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [query, setQuery] = useState<LibraryQuery>({ q: '', sort: 'newest', excludedSources: [], categories: [], collections: [], subtypes: [] });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reqId = useRef(0);   // drops responses from a superseded query
  const loaded = useRef(0);  // how many library items are currently loaded (pages kept across a refresh)
  const lastKey = useRef('');

  const refresh = useCallback(() => setTick(t => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`${BASE}/api/list`).then(r => r.json()),
      fetch(`${BASE}/api/recycle`).then(r => r.json()),
      fetch(`${BASE}/api/facets`).then(r => r.json()),
      fetch(`${BASE}/api/favorites`).then(r => r.json()),
    ])
      .then(([clipRes, recycleRes, facetRes, favRes]) => {
        if (cancelled) return;
        setFavoriteAssets(favRes.assets ?? []);
        setClipboard(clipRes.clips ?? []);
        setRecycle(recycleRes.clips ?? []);
        setFacets(facetRes);
      })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [tick]);

  loaded.current = libraryAssets.length;

  // A NEW query (search, filter, sort) starts from the first page. A plain refresh — a render
  // finishing, a trash, a save — re-fetches the SAME range that's loaded, so the pages you scrolled
  // through are kept and the grid doesn't collapse back to the top (deep in the
  // library, finishing a generation jumped him back to ~item 180). The rail keeps the scroll position
  // by item (AssetRail's anchor), so new items landing above you don't move what you're looking at.
  useEffect(() => {
    const id = ++reqId.current;
    // Source names SORTED: the API orders facets by count, so a render finishing (+1 krea2) could
    // reorder them and make an unchanged query look new — which reset the list to page 1.
    const key = JSON.stringify(query) + '|' + (query.excludedSources.length && facets ? facets.sources.map(f => f.source).sort().join(',') : '');
    const isRefresh = key === lastKey.current;
    lastKey.current = key;
    const want = isRefresh ? Math.max(PAGE, loaded.current) : PAGE;
    if (!isRefresh) setLoading(true);
    fetchRange(query, facets, want)
      .then(res => {
        if (id !== reqId.current) return;
        setLibrary(res.assets);
        setTotal(res.total);
        setError(null);
      })
      .catch(e => { if (id === reqId.current) setError(String(e)); })
      .finally(() => { if (id === reqId.current) setLoading(false); });
  // facets matter for source exclusion (and a type's full subtype list, read as the query is made);
  // re-running on every facets refresh would double-fetch
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, query, query.excludedSources.length ? facets : null]);

  const loadMore = useCallback(() => {
    if (loadingMore || loading || libraryAssets.length >= total) return;
    const id = reqId.current;
    setLoadingMore(true);
    fetch(libraryUrl(query, facets, libraryAssets.length))
      .then(r => r.json())
      .then(res => { if (id === reqId.current) setLibrary(prev => [...prev, ...(res.assets ?? [])]); })
      .catch(e => console.error('load more', e))
      .finally(() => setLoadingMore(false));
  }, [loadingMore, loading, libraryAssets.length, total, query, facets]);

  return {
    clipboardAssets, recycleAssets, favoriteAssets, setFavoriteAssets, libraryAssets, loading, error, refresh,
    library: { query, setQuery, total, loadMore, loadingMore, facets },
  };
}
