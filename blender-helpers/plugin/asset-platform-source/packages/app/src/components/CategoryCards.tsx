import type { AssetCategory } from '../types';

interface Props {
  activeCategory: AssetCategory | null;
  onSelectCategory: (cat: AssetCategory) => void;
}

const CATEGORIES: { id: AssetCategory; label: string }[] = [
  { id: 'image', label: 'Image Tools' },
  { id: 'audio', label: 'Audio Tools' },
  { id: 'video', label: 'Video Tools' },
  { id: 'mesh', label: '3D Mesh Tools' },
];

// Features row — breadcrumb now lives in the global nav bar (App.tsx).
// When a category is active: show chips to switch. When none: show big cards.
export function CategoryCards({ activeCategory, onSelectCategory }: Props) {
  if (activeCategory) {
    return (
      <div className="category-header" data-testid="category-header">
        <div className="category-chips">
          {CATEGORIES.map(cat => (
            <button
              key={cat.id}
              className={`category-chip${activeCategory === cat.id ? ' active' : ''}`}
              onClick={() => onSelectCategory(cat.id)}
              data-testid={`category-chip-${cat.id}`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="category-area" data-testid="category-area">
      <div className="category-cards">
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            className="category-card"
            onClick={() => onSelectCategory(cat.id)}
            data-testid={`category-card-${cat.id}`}
          >
            {cat.label}
          </button>
        ))}
      </div>
    </div>
  );
}
