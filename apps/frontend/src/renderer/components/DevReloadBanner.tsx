/**
 * DevReloadBanner - Shows when backend code has changed and GUI needs reload
 *
 * Only active in development mode. When src/main/, src/preload/, or src/shared/
 * files change, this banner appears prompting the user to reload the GUI.
 * Detached agents survive the reload.
 */
import { useState, useEffect } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Button } from './ui/button';

export function DevReloadBanner() {
  const [showBanner, setShowBanner] = useState(false);
  const [changedFile, setChangedFile] = useState<string | null>(null);

  useEffect(() => {
    // Subscribe to backend changed events
    const unsubscribe = window.electronAPI.onDevBackendChanged((info) => {
      console.log('[DevReloadBanner] Backend code changed:', info.file);
      setChangedFile(info.file);
      setShowBanner(true);
    });

    return unsubscribe;
  }, []);

  const handleReload = async () => {
    console.log('[DevReloadBanner] Reloading GUI...');
    await window.electronAPI.restartApp();
  };

  const handleDismiss = () => {
    setShowBanner(false);
  };

  if (!showBanner) {
    return null;
  }

  // Extract just the filename for display
  const displayFile = changedFile ? changedFile.split(/[/\\]/).pop() : 'unknown';

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-black px-4 py-2 flex items-center justify-between shadow-lg">
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4" />
        <span className="font-medium">
          Backend code changed ({displayFile}) - Reload to apply changes
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleReload}
          className="bg-black text-white hover:bg-gray-800"
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Reload GUI
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          className="hover:bg-amber-600"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
