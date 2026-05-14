'use client';

import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import Icon from '@/components/ui/icon';
import FileManagerDialog from './FileManagerDialog';
import { extractPlainTextFromTiptap, extractMultilinePlainTextFromTiptap } from '@/lib/tiptap-utils';
import { stringToTiptapContent } from '@/lib/text-format-utils';
import { useAsset } from '@/hooks/use-asset';
import { useAssetsStore } from '@/stores/useAssetsStore';
import { getAssetIcon, isAssetOfType, getAssetCategoryFromMimeType, ASSET_CATEGORIES } from '@/lib/asset-utils';
import { buildAssetFolderPath } from '@/lib/asset-folder-utils';
import { toast } from 'sonner';
import type { TranslatableItem } from '@/lib/localisation-utils';
import type { Translation, CreateTranslationData, UpdateTranslationData, Asset, AssetCategory } from '@/types';
import type { IconProps } from '@/components/ui/icon';

interface SidebarTranslationRowProps {
  item: TranslatableItem;
  /**
   * Which half of the translation pair to render. The right sidebar groups
   * rows under language sections (Default → Active), so each item is rendered
   * twice — once as the read-only source, once as the (usually editable)
   * translation for the selected locale.
   */
  side: 'source' | 'translation';
  selectedLocaleId: string | null;
  localInputValues: Record<string, string>;
  onLocalValueChange: (key: string, value: string) => void;
  onLocalValueClear: (key: string) => void;
  getTranslationByKey: (localeId: string, key: string) => Translation | undefined;
  createTranslation: (data: CreateTranslationData) => Promise<Translation | null>;
  updateTranslation: (translation: Translation, data: UpdateTranslationData) => Promise<void>;
  /**
   * When true, the translation side renders a read-only preview with an
   * "Expand to edit" button instead of an editable surface. Used for the
   * rich-text element layer, which edits in the dedicated RichTextEditorSheet.
   */
  previewOnly?: boolean;
  /** Click handler for the "Expand to edit" button shown in preview-only mode. */
  onExpand?: () => void;
}

/**
 * Right-sidebar translation editor for a single (item, side) pair.
 *
 * A deliberately simpler take on `TranslationRow`: stacked plain `Textarea`s,
 * no rich-text editor, no completion toggle, no slug validation. Used while
 * the user is browsing the canvas in a non-default locale.
 *
 * Rich-text values (Tiptap JSON) are flattened to plain text for display and
 * re-wrapped into a Tiptap doc on save so the rendering pipeline keeps getting
 * a valid rich_text content shape.
 */
export default function SidebarTranslationRow({
  item,
  side,
  selectedLocaleId,
  localInputValues,
  onLocalValueChange,
  onLocalValueClear,
  getTranslationByKey,
  createTranslation,
  updateTranslation,
  previewOnly = false,
  onExpand,
}: SidebarTranslationRowProps) {
  const [isAssetPickerOpen, setIsAssetPickerOpen] = useState(false);

  const isRichText = item.content_type === 'richtext';
  const isAsset = item.content_type === 'asset_id';

  // Sub-label shown beneath each language name when a layer has more than
  // one translatable property (e.g. an image has both source + alt text).
  // Plain text content stays unlabelled — the language name plus the textarea
  // already make it obvious what's being translated.
  const propertyLabel = (() => {
    const suffix = item.content_key.split(':').pop();
    switch (suffix) {
      case 'image_alt': return 'Image ALT';
      case 'image_src': return 'Image';
      case 'video_src': return 'Video';
      case 'video_poster': return 'Video poster';
      case 'audio_src': return 'Audio';
      case 'icon_src': return 'Icon';
      default: return null;
    }
  })();

  const translation = selectedLocaleId
    ? getTranslationByKey(selectedLocaleId, item.key)
    : null;
  const storeValue = translation?.content_value || '';

  // Display value for the source textarea: convert Tiptap JSON → plain text so
  // the user sees readable content instead of raw JSON for rich-text fields.
  // In preview-only mode (rich-text element layers) we keep block-level
  // structure as newlines so headings/paragraphs render the way they do on
  // the canvas; the editable textarea path stays single-line so it round-trips
  // cleanly through stringToTiptapContent on save.
  const sourceDisplayValue = (() => {
    if (!isRichText || !item.content_value) return item.content_value || '';
    try {
      const parsed = JSON.parse(item.content_value);
      return previewOnly
        ? extractMultilinePlainTextFromTiptap(parsed)
        : extractPlainTextFromTiptap(parsed);
    } catch {
      return item.content_value;
    }
  })();

  // Same plain-text projection for the translation: prefer in-flight local
  // input, fall back to whatever is stored on the server.
  const translationDisplayValue = (() => {
    if (localInputValues[item.key] !== undefined) {
      return localInputValues[item.key];
    }
    if (!isRichText || !storeValue) return storeValue || '';
    try {
      const parsed = JSON.parse(storeValue);
      return previewOnly
        ? extractMultilinePlainTextFromTiptap(parsed)
        : extractPlainTextFromTiptap(parsed);
    } catch {
      return storeValue;
    }
  })();

  const sourceAsset = useAsset(isAsset ? item.content_value : null);
  const translatedAsset = useAsset(isAsset ? storeValue : null);
  const displayedAsset = translatedAsset || sourceAsset;
  const assetCategory: AssetCategory | null = sourceAsset
    ? getAssetCategoryFromMimeType(sourceAsset.mime_type)
    : null;
  const assetFolders = useAssetsStore((state) => state.folders);

  const handleTextChange = (value: string) => {
    onLocalValueChange(item.key, value);
  };

  const handleTextBlur = (value: string) => {
    if (!selectedLocaleId) return;

    // Re-wrap plain text into Tiptap JSON for rich_text fields so the
    // rendering pipeline still receives a valid rich_text payload.
    const finalValue = isRichText
      ? JSON.stringify(stringToTiptapContent(value))
      : value;

    onLocalValueClear(item.key);

    // Skip the round-trip when nothing actually changed (handles the case
    // where the user focuses then blurs without editing).
    const previousValue = storeValue;
    if (finalValue === previousValue) return;
    if (!finalValue && !previousValue) return;

    // The simplified sidebar flow has no explicit "complete" toggle — saving
    // any value here means the user committed it, so we mark it completed so
    // injectTranslatedText / runtime rendering picks it up. Partial translations
    // that were created elsewhere also flip to completed on first save here.
    const savePromise = translation
      ? updateTranslation(translation, { content_value: finalValue, is_completed: true })
      : createTranslation({
        locale_id: selectedLocaleId,
        source_type: item.source_type as CreateTranslationData['source_type'],
        source_id: item.source_id,
        content_key: item.content_key,
        content_type: item.content_type as CreateTranslationData['content_type'],
        content_value: finalValue,
        is_completed: true,
      });

    savePromise.catch((error) => console.error('Failed to save translation:', error));
  };

  const handleAssetSelect = (asset: Asset): void | false => {
    if (!selectedLocaleId) return false;

    if (assetCategory && asset.mime_type && !isAssetOfType(asset.mime_type, assetCategory)) {
      const categoryLabels: Record<AssetCategory, string> = {
        images: 'an image',
        videos: 'a video',
        audio: 'an audio file',
        icons: 'an icon',
        documents: 'a document',
      };
      toast.error('Invalid asset type', {
        description: `Please select ${categoryLabels[assetCategory] || 'a file with the correct type'}.`,
      });
      return false;
    }

    onLocalValueChange(item.key, asset.id);

    const savePromise = translation
      ? updateTranslation(translation, { content_value: asset.id, is_completed: true })
      : createTranslation({
        locale_id: selectedLocaleId,
        source_type: item.source_type as CreateTranslationData['source_type'],
        source_id: item.source_id,
        content_key: item.content_key,
        content_type: item.content_type as CreateTranslationData['content_type'],
        content_value: asset.id,
        is_completed: true,
      });

    savePromise
      .catch((error) => console.error('Failed to save asset translation:', error))
      .finally(() => setIsAssetPickerOpen(false));
  };

  const getAssetFolderPath = (asset: Asset | null): string | null => {
    if (!asset) return null;
    if (!asset.asset_folder_id) return 'All files';
    const folder = assetFolders.find((f) => f.id === asset.asset_folder_id);
    if (!folder) return 'All files';
    const folderPath = buildAssetFolderPath(folder, assetFolders) as string;
    return `All files / ${folderPath}`;
  };

  const renderAssetPreview = (asset: Asset) => {
    const isIcon = !!asset.content && isAssetOfType(asset.mime_type, ASSET_CATEGORIES.ICONS);
    const isVideo = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.VIDEOS);
    const isAudio = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.AUDIO);
    const isImage = isAssetOfType(asset.mime_type, ASSET_CATEGORIES.IMAGES) && !isIcon;
    const folderPath = getAssetFolderPath(asset);
    const showCheckerboard = isIcon || isImage;

    return (
      <>
        <div className="size-8 rounded overflow-hidden flex-shrink-0 flex items-center justify-center relative">
          {showCheckerboard
            ? <div className="absolute inset-0 opacity-10 bg-checkerboard" />
            : <div className="absolute inset-0 bg-secondary" />
          }
          {isIcon && asset.content ? (
            <div
              data-icon="true"
              className="relative w-full h-full flex items-center justify-center text-foreground p-1 z-10"
              dangerouslySetInnerHTML={{ __html: asset.content }}
            />
          ) : isVideo || isAudio ? (
            <Icon name={getAssetIcon(asset.mime_type) as IconProps['name']} className="size-4 opacity-50 relative z-10" />
          ) : isImage && asset.public_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={asset.public_url}
              alt={asset.filename}
              className="relative w-full h-full object-cover z-10"
            />
          ) : (
            <Icon name={getAssetIcon(asset.mime_type) as IconProps['name']} className="size-4 opacity-50 relative z-10" />
          )}
        </div>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-xs truncate text-foreground/80">{asset.filename}</span>
          {folderPath && (
            <span className="text-[11px] text-muted-foreground/70 truncate">{folderPath}</span>
          )}
        </div>
      </>
    );
  };

  // Cap height so long translations scroll inside the field instead of
  // pushing the rest of the inspector down (Textarea uses field-sizing-content
  // by default, which auto-grows).
  const textareaClass = 'resize-none max-h-32 overflow-y-auto';

  return (
    <div className="flex flex-col gap-1.5">
      {propertyLabel && (
        <Label className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">
          {propertyLabel}
        </Label>
      )}

      {side === 'source' ? (
        isAsset ? (
          <div className="flex items-center gap-2 p-2 border border-border/50 rounded-md bg-secondary/20 opacity-80">
            {sourceAsset && renderAssetPreview(sourceAsset)}
          </div>
        ) : (
          <Textarea
            value={sourceDisplayValue}
            readOnly
            tabIndex={-1}
            className={`${textareaClass} text-muted-foreground`}
            rows={3}
          />
        )
      ) : (
        <>
          {isAsset ? (
            <div
              className="flex items-center gap-2 p-2 border border-border/50 rounded-md bg-secondary/20 cursor-pointer hover:bg-secondary/35 transition-colors"
              onClick={() => setIsAssetPickerOpen(true)}
            >
              {displayedAsset && renderAssetPreview(displayedAsset)}
            </div>
          ) : previewOnly ? (
            <Textarea
              value={translationDisplayValue}
              readOnly
              tabIndex={-1}
              placeholder={sourceDisplayValue || 'No translation yet'}
              className={`${textareaClass} text-muted-foreground`}
              rows={3}
            />
          ) : (
            <Textarea
              value={translationDisplayValue}
              onChange={(e) => handleTextChange(e.target.value)}
              onBlur={(e) => handleTextBlur(e.target.value)}
              placeholder={sourceDisplayValue || 'Enter translation...'}
              className={textareaClass}
              rows={3}
            />
          )}
          {previewOnly && onExpand && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="gap-2.5 mt-1"
              onClick={onExpand}
            >
              Expand to edit
              <span><Icon name="expand" className="size-2.5" /></span>
            </Button>
          )}
        </>
      )}

      {side === 'translation' && isAsset && (
        <FileManagerDialog
          open={isAssetPickerOpen}
          onOpenChange={setIsAssetPickerOpen}
          onAssetSelect={handleAssetSelect}
          assetId={storeValue || item.content_value || null}
          category={assetCategory || undefined}
        />
      )}
    </div>
  );
}
