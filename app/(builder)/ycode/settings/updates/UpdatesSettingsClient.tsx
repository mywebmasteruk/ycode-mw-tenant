'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  FieldDescription,
  FieldLegend,
  FieldSeparator
} from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import Icon from '@/components/ui/icon';
import { Label } from '@/components/ui/label';
import { Empty, EmptyTitle } from '@/components/ui/empty';

type AdminUpdateStatus =
  | 'up_to_date'
  | 'update_available'
  | 'preparing'
  | 'checks_running'
  | 'safe_to_review'
  | 'needs_safety_review'
  | 'blocked'
  | 'failed_checks'
  | 'setup_required'
  | 'unknown_error';

interface AdminUpdateCenterStatus {
  ok: boolean;
  status: AdminUpdateStatus;
  title: string;
  description: string;
  currentVersion: string;
  latestVersion?: string;
  canPrepare: boolean;
  primaryActionLabel?: string;
  reviewUrl?: string;
  workflowUrl?: string;
  productionProtected: boolean;
  technicalDetails?: string;
}

interface Release {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  url: string;
  isCurrent: boolean;
  isPrerelease: boolean;
}

interface ReleasesResponse {
  releases: Release[];
  currentVersion: string;
  error?: string;
}

marked.setOptions({
  gfm: true,
  breaks: true,
});

const STATUS_BADGE: Record<AdminUpdateStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'green' }> = {
  up_to_date: { label: 'Up to date', variant: 'green' },
  update_available: { label: 'Update available', variant: 'default' },
  preparing: { label: 'Preparing', variant: 'secondary' },
  checks_running: { label: 'Checks running', variant: 'secondary' },
  safe_to_review: { label: 'Checks passed', variant: 'green' },
  needs_safety_review: { label: 'Needs review', variant: 'destructive' },
  blocked: { label: 'Blocked', variant: 'destructive' },
  failed_checks: { label: 'Failed checks', variant: 'destructive' },
  setup_required: { label: 'Setup needed', variant: 'outline' },
  unknown_error: { label: 'Status unavailable', variant: 'outline' },
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function statusIcon(status: AdminUpdateStatus) {
  if (status === 'up_to_date' || status === 'safe_to_review') return 'check';
  if (status === 'preparing' || status === 'checks_running') return 'refresh';
  return 'info';
}

function shouldPollStatus(status?: AdminUpdateStatus) {
  return status === 'preparing' || status === 'checks_running';
}

export default function UpdatesSettingsClient() {
  const [updateStatus, setUpdateStatus] = useState<AdminUpdateCenterStatus | null>(null);
  const [releases, setReleases] = useState<Release[]>([]);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [prepareMessage, setPrepareMessage] = useState<string | null>(null);
  const [releasesLoading, setReleasesLoading] = useState(true);
  const [releasesError, setReleasesError] = useState<string | null>(null);

  const fetchUpdateStatus = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/ycode/api/updates/status');
      const data = await response.json();
      if (response.ok) {
        setUpdateStatus(data);
      } else {
        setUpdateStatus({
          ok: false,
          status: 'unknown_error',
          title: data?.title || 'Unable to read update status',
          description: data?.description || 'MasjidWeb could not read the safe update status. Production has not changed.',
          currentVersion: data?.currentVersion || 'Unknown',
          latestVersion: data?.latestVersion,
          canPrepare: false,
          productionProtected: true,
          technicalDetails: data?.technicalDetails || data?.error,
        });
      }
    } catch (error) {
      console.error('Failed to check update status:', error);
      setUpdateStatus({
        ok: false,
        status: 'unknown_error',
        title: 'Unable to read update status',
        description: 'MasjidWeb could not read the safe update status. Production has not changed.',
        currentVersion: 'Unknown',
        canPrepare: false,
        productionProtected: true,
        technicalDetails: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchReleases = useCallback(async () => {
    setReleasesLoading(true);
    setReleasesError(null);
    try {
      const response = await fetch('/ycode/api/updates/releases');
      if (response.ok) {
        const data: ReleasesResponse = await response.json();
        setReleases(data.releases || []);
        if (data.error) {
          setReleasesError(data.error);
        }
      } else {
        setReleasesError(`Failed to fetch releases: ${response.status}`);
      }
    } catch (error) {
      console.error('Failed to fetch releases:', error);
      setReleasesError('Failed to fetch releases');
    } finally {
      setReleasesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUpdateStatus();
    fetchReleases();
  }, [fetchUpdateStatus, fetchReleases]);

  useEffect(() => {
    if (!shouldPollStatus(updateStatus?.status)) return;

    const interval = window.setInterval(fetchUpdateStatus, 10000);
    return () => window.clearInterval(interval);
  }, [fetchUpdateStatus, updateStatus?.status]);

  const currentBadge = useMemo(() => {
    return STATUS_BADGE[updateStatus?.status || 'unknown_error'];
  }, [updateStatus?.status]);

  const prepareSafeUpdate = async () => {
    setPreparing(true);
    setPrepareMessage(null);
    try {
      const response = await fetch('/ycode/api/updates/prepare', { method: 'POST' });
      const data = await response.json();

      if (!response.ok) {
        setPrepareMessage(data?.message || data?.error || 'Unable to start safe update preparation. Production has not changed.');
        return;
      }

      setPrepareMessage(data.message || 'Safe update preparation has started. Production has not changed.');
      await fetchUpdateStatus();
    } catch (error) {
      console.error('Failed to prepare safe update:', error);
      setPrepareMessage('Unable to start safe update preparation. Production has not changed.');
    } finally {
      setPreparing(false);
    }
  };

  return (
    <div className="p-8">
      <div className="max-w-3xl mx-auto">

        <header className="pt-8 pb-3">
          <span className="text-base font-medium">Core updates</span>
        </header>

        <div className="grid grid-cols-3 gap-10 bg-secondary/20 p-8 rounded-lg">

          <div>
            <FieldLegend>MasjidWeb update center</FieldLegend>
            <FieldDescription>
              Prepare Ycode core updates safely from inside admin. This does not change production directly.
            </FieldDescription>
          </div>

          <div className="col-span-2">
            {loading && !updateStatus ? (
              <Empty className="bg-input">
                <Spinner />
              </Empty>
            ) : updateStatus ? (
              <div className="flex flex-col gap-5">
                <div className="flex items-start gap-4">
                  <div className="size-12 rounded-full bg-secondary flex items-center justify-center shrink-0">
                    {shouldPollStatus(updateStatus.status) ? (
                      <Spinner />
                    ) : (
                      <Icon name={statusIcon(updateStatus.status)} className="size-6" />
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label>{updateStatus.title}</Label>
                      <Badge variant={currentBadge.variant}>{currentBadge.label}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground leading-6">
                      {updateStatus.description}
                    </p>
                  </div>
                </div>

                <FieldSeparator />

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-lg bg-input p-3">
                    <div className="text-muted-foreground">Current core version</div>
                    <div className="font-medium mt-1">{updateStatus.currentVersion}</div>
                  </div>
                  <div className="rounded-lg bg-input p-3">
                    <div className="text-muted-foreground">Latest available version</div>
                    <div className="font-medium mt-1">{updateStatus.latestVersion || 'Unknown'}</div>
                  </div>
                </div>

                <div className="rounded-lg border border-border p-4 bg-background/40">
                  <div className="flex items-start gap-3">
                    <Icon name="info" className="size-5 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium">Production is protected</div>
                      <div className="text-sm text-muted-foreground mt-1">
                        The button only prepares a safe update and safety report. The live site changes only after the protected review path is approved.
                      </div>
                    </div>
                  </div>
                </div>

                {prepareMessage && (
                  <div className="rounded-lg bg-input p-3 text-sm text-muted-foreground">
                    {prepareMessage}
                  </div>
                )}

                {updateStatus.technicalDetails && (
                  <div className="rounded-lg bg-input p-3 text-sm text-muted-foreground">
                    {updateStatus.technicalDetails}
                  </div>
                )}

                <div className="flex flex-wrap gap-3">
                  <Button
                    size="sm"
                    disabled={!updateStatus.canPrepare || preparing}
                    onClick={prepareSafeUpdate}
                  >
                    {preparing ? <Spinner /> : null}
                    {updateStatus.primaryActionLabel || 'Prepare safe update'}
                  </Button>

                  <Button
                    size="sm" variant="secondary"
                    onClick={fetchUpdateStatus} disabled={loading || preparing}
                  >
                    Check status again
                  </Button>

                  {updateStatus.reviewUrl && (
                    <Button
                      size="sm" variant="outline"
                      asChild
                    >
                      <a
                        href={updateStatus.reviewUrl} target="_blank"
                        rel="noopener noreferrer"
                      >
                        View prepared update
                      </a>
                    </Button>
                  )}

                  {updateStatus.workflowUrl && (
                    <Button
                      size="sm" variant="outline"
                      asChild
                    >
                      <a
                        href={updateStatus.workflowUrl} target="_blank"
                        rel="noopener noreferrer"
                      >
                        View preparation run
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <Empty className="bg-input">
                <EmptyTitle>Unable to read update status</EmptyTitle>
              </Empty>
            )}
          </div>

        </div>

        <div className="grid grid-cols-3 gap-10 bg-secondary/20 p-8 rounded-lg mt-6">

          <div>
            <FieldLegend>Release history</FieldLegend>
            <FieldDescription>
              View Ycode releases and changelogs. Use the update center above to prepare updates safely.
            </FieldDescription>
          </div>

          <div className="col-span-2">
            {releasesLoading ? (
              <Empty className="bg-input">
                <Spinner />
              </Empty>
            ) : releasesError ? (
              <Empty className="bg-input">
                <EmptyTitle>{releasesError}</EmptyTitle>
              </Empty>
            ) : releases.length === 0 ? (
              <Empty className="bg-input">
                <EmptyTitle>No releases found</EmptyTitle>
              </Empty>
            ) : (
              <ul className="divide-y divide-border">
                {(() => {
                  const currentIndex = releases.findIndex((r) => r.isCurrent);
                  return releases.map((release, index) => {
                    return (
                      <li key={release.version}>
                        <div className="relative flex gap-x-4 py-5">
                          <div className="absolute top-0 bottom-0 left-0 flex w-6 justify-center">
                            <div className="w-px bg-secondary"></div>
                          </div>
                          <div className="relative flex size-6 flex-none items-center justify-center bg-[#1c1c1c]">
                            {release.isCurrent && updateStatus?.status === 'up_to_date' ? (
                              <div className="size-1.5 rounded-full bg-green-400 ring ring-green-400" />
                            ) : release.isCurrent ? (
                              <div className="size-1.5 rounded-full bg-white/50 ring ring-white/50" />
                            ) : currentIndex !== -1 && index < currentIndex ? (
                              <div className="size-1.5 rounded-full bg-primary ring ring-primary" />
                            ) : (
                              <div className="size-1.5 rounded-full bg-[#1c1c1c] ring ring-secondary" />
                            )}
                          </div>

                          <div className="flex-auto py-0.5">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge
                                variant={
                                  index === 0 && release.isCurrent ? 'green' :
                                    index === 0 ? 'default' :
                                      release.isCurrent ? 'secondary' :
                                        'outline'
                                }
                                className="gap-2"
                              >
                                {release.version}
                              </Badge>
                              <div className="size-1 bg-secondary rounded-full" />
                              <time className="flex-none py-0.5 opacity-50">{formatDate(release.publishedAt)}</time>
                              {release.isCurrent && (
                                <div className="flex items-center gap-2">
                                  <div className="size-1 bg-secondary rounded-full" />
                                  <Label variant="muted">Current</Label>
                                </div>
                              )}
                              {index === 0 && !release.isCurrent && (
                                <div className="flex items-center gap-2">
                                  <div className="size-1 bg-secondary rounded-full" />
                                  <Label variant="muted">Newest</Label>
                                </div>
                              )}
                            </div>
                            {release.isPrerelease && (
                              <Badge variant="outline" className="text-xs mt-2">Pre-release</Badge>
                            )}
                            {release.body && (
                              <div
                                className="mt-2 prose prose-sm dark:prose-invert max-w-none text-sm text-muted-foreground [&>ul]:list-disc [&>ul]:ml-4 [&>ol]:list-decimal [&>ol]:ml-4 [&>p]:mb-2 [&>h1]:text-base [&>h1]:font-semibold [&>h1]:mb-2 [&>h2]:text-sm [&>h2]:font-semibold [&>h2]:mb-2 [&>h3]:text-sm [&>h3]:font-medium [&>h3]:mb-1"
                                dangerouslySetInnerHTML={{ __html: marked(release.body) as string }}
                              />
                            )}
                          </div>

                        </div>
                      </li>
                    );
                  });
                })()}
              </ul>
            )}
          </div>

        </div>

      </div>
    </div>
  );
}
