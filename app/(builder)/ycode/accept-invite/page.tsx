'use client';

/**
 * Accept Invite Page
 *
 * Handles user invitation flow - allows invited users to set their password
 * and complete their account setup.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@/lib/supabase-browser';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from '@/components/ui/field';

type InviteVerificationResult =
  | { ok: true; email: string | null; next: 'set-password' | 'open-builder' }
  | { ok: false; message: string };

async function requirePersistedSession(
  supabase: NonNullable<Awaited<ReturnType<typeof createBrowserClient>>>,
): Promise<InviteVerificationResult | null> {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();

  if (error || !session?.user) {
    return {
      ok: false,
      message: 'Authentication link was accepted, but the session could not be saved. Please request a new link.',
    };
  }

  return null;
}

async function persistMagicLinkSessionOnServer(
  accessToken: string,
  refreshToken: string,
): Promise<InviteVerificationResult> {
  const response = await fetch('/ycode/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, refreshToken }),
  });

  const payload = await response.json().catch(() => null) as {
    data?: { user?: { email?: string | null } };
    error?: string;
  } | null;

  if (!response.ok || !payload?.data?.user) {
    return {
      ok: false,
      message: payload?.error || 'Authentication link was accepted, but the session could not be saved. Please request a new link.',
    };
  }

  return {
    ok: true,
    email: payload.data.user.email ?? null,
    next: 'open-builder',
  };
}

async function verifyInviteFromUrl(
  supabase: NonNullable<Awaited<ReturnType<typeof createBrowserClient>>>,
): Promise<InviteVerificationResult> {
  const url = new URL(window.location.href);
  const query = url.searchParams;
  const hashParams = new URLSearchParams(window.location.hash.substring(1));

  const typeFromQuery = query.get('type');
  const typeFromHash = hashParams.get('type');
  const flowType = typeFromHash || typeFromQuery;

  const isInvite = flowType === 'invite';
  const isMagicLink = flowType === 'magiclink';

  // Flow A: legacy hash fragment with access + refresh tokens
  const accessToken = hashParams.get('access_token');
  const refreshToken = hashParams.get('refresh_token');
  if ((isInvite || isMagicLink) && accessToken && refreshToken) {
    if (isMagicLink) {
      return persistMagicLinkSessionOnServer(accessToken, refreshToken);
    }

    const { data, error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) {
      return {
        ok: false,
        message: 'Invalid or expired authentication link. Please request a new link.',
      };
    }

    const persistedSessionError = await requirePersistedSession(supabase);
    if (persistedSessionError) return persistedSessionError;

    return {
      ok: true,
      email: data.user?.email ?? null,
      next: 'set-password',
    };
  }

  // Flow B: token_hash + type=invite|magiclink (Supabase OTP verify flow)
  const tokenHash = query.get('token_hash');
  if ((isInvite || isMagicLink) && tokenHash) {
    const { data, error } = await supabase.auth.verifyOtp({
      type: isMagicLink ? 'magiclink' : 'invite',
      token_hash: tokenHash,
    });
    if (error) {
      return {
        ok: false,
        message: 'Invalid or expired authentication link. Please request a new link.',
      };
    }

    const persistedSessionError = await requirePersistedSession(supabase);
    if (persistedSessionError) return persistedSessionError;

    return {
      ok: true,
      email: data.user?.email ?? null,
      next: isMagicLink ? 'open-builder' : 'set-password',
    };
  }

  // Flow C: code query param exchange (PKCE/code flow)
  const code = query.get('code');
  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return {
        ok: false,
        message: 'Invalid or expired authentication link. Please request a new link.',
      };
    }

    const persistedSessionError = await requirePersistedSession(supabase);
    if (persistedSessionError) return persistedSessionError;

    return {
      ok: true,
      email: data.user?.email ?? null,
      next: isMagicLink ? 'open-builder' : 'set-password',
    };
  }

  return {
    ok: false,
    message:
      'Invalid invitation link. Please check your email for the correct link or request a new invite.',
  };
}

export default function AcceptInvitePage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // Ensure dark mode is applied
  useEffect(() => {
    document.documentElement.classList.add('dark');

    return () => {
      document.documentElement.classList.remove('dark');
    };
  }, []);

  // Verify the invite token on mount
  useEffect(() => {
    const verifyInvite = async () => {
      try {
        const supabase = await createBrowserClient();

        if (!supabase) {
          setError('Application not configured. Please contact the administrator.');
          setVerifying(false);
          return;
        }

        const verify = await verifyInviteFromUrl(supabase);
        if (verify.ok) {
          if (verify.next === 'open-builder') {
            window.location.assign('/ycode');
            return;
          }
          setUserEmail(verify.email);
          setVerifying(false);
          return;
        }

        // Check if user is already logged in (maybe clicked link while logged in)
        const { data: { session } } = await supabase.auth.getSession();

        if (session?.user) {
          // User is already authenticated, redirect to app
          router.push('/ycode');
          return;
        }

        // No valid token found
        setError(verify.message);
        setVerifying(false);
      } catch (err) {
        console.error('Error verifying invite:', err);
        setError('Failed to verify invitation. Please try again.');
        setVerifying(false);
      }
    };

    verifyInvite();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate passwords
    if (!password || !confirmPassword) {
      setError('Please fill in all fields');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);

    try {
      const supabase = await createBrowserClient();

      if (!supabase) {
        setError('Application not configured');
        setLoading(false);
        return;
      }

      // Update the user's password
      const { error: updateError } = await supabase.auth.updateUser({
        password: password,
      });

      if (updateError) {
        setError(updateError.message);
        setLoading(false);
        return;
      }

      // Success! Redirect to the app
      router.push('/ycode');
    } catch (err) {
      console.error('Error setting password:', err);
      setError('Failed to set password. Please try again.');
      setLoading(false);
    }
  };

  // Show loading while verifying
  if (verifying) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <div className="flex flex-col items-center gap-4">
          <Spinner />
          <Label variant="muted">Verifying invitation...</Label>
        </div>
      </div>
    );
  }

  // Show error state if verification failed
  if (error && !userEmail) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-neutral-950">
        <div className="w-full max-w-md p-8">
          <div className="flex flex-col items-center gap-6">
            <svg
              className="size-10 fill-current"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <g
                stroke="none" strokeWidth="1"
                fill="none" fillRule="evenodd"
              >
                <g transform="translate(-30.000000, -30.000000)">
                  <g>
                    <g transform="translate(30.000000, 30.000000)">
                      <rect
                        x="0" y="0"
                        width="24" height="24"
                      />
                      <path
                        d="M11.4241533,0 L11.4241533,5.85877951 L6.024,8.978 L12.6155735,12.7868008 L10.951,13.749 L23.0465401,6.75101349 L23.0465401,12.6152717 L3.39516096,23.9856666 L3.3703726,24 L3.34318129,23.9827156 L0.96,22.4713365 L0.96,16.7616508 L3.36417551,18.1393242 L7.476,15.76 L0.96,11.9090099 L0.96,6.05375516 L11.4241533,0 Z"
                        className="fill-current"
                      />
                    </g>
                  </g>
                </g>
              </g>
            </svg>

            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>

            <Button
              variant="secondary"
              onClick={() => router.push('/login')}
            >
              Go to Login
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Show password setup form
  return (
    <div className="min-h-screen flex flex-col bg-neutral-950">
      <div className="pt-12 pb-8 flex items-center justify-center">
        <svg
          className="size-5 fill-current"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g
            stroke="none" strokeWidth="1"
            fill="none" fillRule="evenodd"
          >
            <g transform="translate(-30.000000, -30.000000)">
              <g>
                <g transform="translate(30.000000, 30.000000)">
                  <rect
                    x="0" y="0"
                    width="24" height="24"
                  />
                  <path
                    d="M11.4241533,0 L11.4241533,5.85877951 L6.024,8.978 L12.6155735,12.7868008 L10.951,13.749 L23.0465401,6.75101349 L23.0465401,12.6152717 L3.39516096,23.9856666 L3.3703726,24 L3.34318129,23.9827156 L0.96,22.4713365 L0.96,16.7616508 L3.36417551,18.1393242 L7.476,15.76 L0.96,11.9090099 L0.96,6.05375516 L11.4241533,0 Z"
                    className="fill-current"
                  />
                </g>
              </g>
            </g>
          </g>
        </svg>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center py-10">
        <div className="w-full max-w-md px-8">
          <form onSubmit={handleSubmit}>
            <FieldGroup
              className="animate-in fade-in slide-in-from-bottom-1 duration-700"
              style={{ animationFillMode: 'both' }}
            >
              {userEmail && (
                <div className="text-center mb-6">
                  <Label variant="muted" size="sm">
                    Setting up account for {userEmail}
                  </Label>
                </div>
              )}

              <FieldSet>
                <FieldGroup className="gap-6">
                  {error && (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}

                  <Field>
                    <FieldLabel htmlFor="password" size="sm">
                      Password
                    </FieldLabel>
                    <Input
                      type="password"
                      id="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      size="sm"
                      autoFocus
                    />
                    <FieldDescription>At least 6 characters</FieldDescription>
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="confirmPassword" size="sm">
                      Confirm password
                    </FieldLabel>
                    <Input
                      type="password"
                      id="confirmPassword"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      disabled={loading}
                      size="sm"
                    />
                  </Field>

                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full mt-4"
                  >
                    {loading ? <Spinner /> : 'Create account'}
                  </Button>
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
          </form>
        </div>
      </div>
    </div>
  );
}
