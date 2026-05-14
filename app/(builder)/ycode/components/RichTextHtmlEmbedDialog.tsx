'use client';

import React, { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface RichTextHtmlEmbedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  code: string;
  onSave: (code: string) => void;
}

export default function RichTextHtmlEmbedDialog({
  open,
  onOpenChange,
  code,
  onSave,
}: RichTextHtmlEmbedDialogProps) {
  const [localCode, setLocalCode] = useState(code);

  useEffect(() => {
    if (open) {
      setLocalCode(code);
    }
  }, [open, code]);

  const handleSave = () => {
    onSave(localCode);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Edit HTML Embed</DialogTitle>
        </DialogHeader>
        <Textarea
          value={localCode}
          onChange={(e) => setLocalCode(e.target.value)}
          placeholder="<div>Add your custom HTML or <script> here</div>"
          className="font-mono text-xs min-h-[200px] max-h-[40vh] overflow-y-auto resize-none"
          spellCheck={false}
        />
        <DialogFooter>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
