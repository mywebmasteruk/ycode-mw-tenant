'use client';

import { useEffect, useMemo, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/ui/icon';
import { useDebounce } from '@/hooks/use-debounce';
import { useCollectionsStore } from '@/stores/useCollectionsStore';

interface CollectionItemSelectorProps {
  collectionId: string;
  value: string | null;
  onValueChange: (id: string) => void;
}

const SEARCH_LIMIT = 50;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Top-bar picker for the active collection item on dynamic pages.
 *
 * Items are sourced from the preloaded store cache; typing triggers a
 * debounced server search that merges results into the cache so the
 * canvas can resolve items beyond the initial preload window.
 */
export default function CollectionItemSelector({
  collectionId,
  value,
  onValueChange,
}: CollectionItemSelectorProps) {
  const itemsByCollection = useCollectionsStore((s) => s.items);
  const fieldsByCollection = useCollectionsStore((s) => s.fields);
  const searchAndMergeItems = useCollectionsStore((s) => s.searchAndMergeItems);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);
  const [isSearching, setIsSearching] = useState(false);

  const dropdownItems = useMemo(() => {
    const items = itemsByCollection[collectionId] || [];
    const fields = fieldsByCollection[collectionId] || [];
    const nameField = fields.find((f) => f.key === 'name');
    return items.map((item) => {
      let label = `Item ${item.id.slice(0, 8)}`;
      if (nameField) {
        const nameValue = item.values?.[nameField.id];
        if (nameValue !== null && nameValue !== undefined && String(nameValue).trim() !== '') {
          label = String(nameValue);
        }
      }
      return { id: item.id, label };
    });
  }, [collectionId, itemsByCollection, fieldsByCollection]);

  const trimmedSearch = debouncedSearch.trim();

  useEffect(() => {
    if (!trimmedSearch) {
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    setIsSearching(true);
    searchAndMergeItems(collectionId, trimmedSearch, SEARCH_LIMIT)
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });

    return () => { cancelled = true; };
  }, [collectionId, trimmedSearch, searchAndMergeItems]);

  // Auto-select the first item when none is selected yet
  useEffect(() => {
    if (!value && dropdownItems.length > 0) {
      onValueChange(dropdownItems[0].id);
    }
  }, [value, dropdownItems, onValueChange]);

  const filteredItems = useMemo(() => {
    if (!search.trim()) return dropdownItems;
    const needle = search.toLowerCase();
    return dropdownItems.filter((item) => item.label.toLowerCase().includes(needle));
  }, [dropdownItems, search]);

  const selectedLabel = dropdownItems.find((item) => item.id === value)?.label || 'Select item';
  const hasNoItems = dropdownItems.length === 0 && !isSearching;

  const handleOpenChange = (open: boolean) => {
    if (!open) setSearch('');
  };

  return (
    <Select
      value={value || ''}
      onValueChange={(next) => {
        onValueChange(next);
        setSearch('');
      }}
      onOpenChange={handleOpenChange}
      disabled={hasNoItems}
    >
      <SelectTrigger className="w-24 justify-between" size="sm">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0">
                <Icon name="database" className="size-3 opacity-50" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Collection item</TooltipContent>
          </Tooltip>
          <span className="truncate">{selectedLabel}</span>
        </div>
      </SelectTrigger>

      <SelectContent
        searchable
        searchValue={search}
        onSearchChange={setSearch}
        searchPlaceholder="Search items..."
        searchLoading={isSearching}
        align="start"
        className="min-w-72 max-w-96"
      >
        {filteredItems.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">
            {search ? (isSearching ? 'Searching...' : 'No items found') : 'No items available'}
          </div>
        ) : (
          filteredItems.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              <span className="truncate">{item.label}</span>
            </SelectItem>
          ))
        )}
      </SelectContent>
    </Select>
  );
}
