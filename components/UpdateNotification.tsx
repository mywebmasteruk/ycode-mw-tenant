'use client';

import { useState, useEffect } from 'react';

interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
}

export default function UpdateNotification() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkForUpdates();

    const interval = setInterval(checkForUpdates, 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const checkForUpdates = async () => {
    try {
      const response = await fetch('/ycode/api/updates/check');
      if (response.ok) {
        const data = await response.json();
        setUpdateInfo(data);
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem('ycode-update-dismissed', Date.now().toString());
  };

  if (loading || !updateInfo?.available || dismissed) {
    return null;
  }

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-lg">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <svg
              className="w-6 h-6 animate-pulse" fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v3.586L7.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 10.586V7z"
                clipRule="evenodd"
              />
            </svg>
            <div>
              <p className="font-semibold">
                New Ycode core update available
              </p>
              <p className="text-sm text-blue-100">
                Version {updateInfo.latestVersion} is available. Open the update center to prepare it safely.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <a
              href="/ycode/settings/updates"
              className="bg-white text-blue-600 hover:bg-blue-50 font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-2 whitespace-nowrap"
            >
              Open update center
            </a>

            <button
              onClick={handleDismiss}
              className="text-white hover:text-blue-100 p-2 transition-colors"
              aria-label="Dismiss"
            >
              <svg
                className="w-5 h-5" fill="none"
                stroke="currentColor" viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round" strokeLinejoin="round"
                  strokeWidth={2} d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
