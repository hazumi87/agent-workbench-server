import { useCallback, useState } from 'react';
import type { Asset } from '../types';

export function useToolSelection() {
  const [selectedAssets, setSelectedAssets] = useState<Asset[]>([]);

  // maxSlots=0 means no tool active (no selection allowed via toggle).
  // maxSlots=1 means single-select (replace on toggle-on).
  // maxSlots>1 means multi-select up to cap (block beyond cap).
  const toggleAsset = useCallback((asset: Asset, maxSlots: number = 0) => {
    if (maxSlots === 0) return;
    setSelectedAssets(prev => {
      const idx = prev.findIndex(a => a.id === asset.id);
      if (idx >= 0) return prev.filter(a => a.id !== asset.id);
      if (maxSlots === 1) return [asset];
      if (prev.length >= maxSlots) return prev;
      return [...prev, asset];
    });
  }, []);

  const removeAsset = useCallback((index: number) => {
    setSelectedAssets(prev => prev.filter((_, i) => i !== index));
  }, []);

  const clearSelection = useCallback(() => setSelectedAssets([]), []);

  const isSelected = useCallback((id: string) =>
    selectedAssets.some(a => a.id === id), [selectedAssets]);

  return { selectedAssets, toggleAsset, removeAsset, clearSelection, isSelected };
}
