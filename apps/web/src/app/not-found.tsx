import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-5xl font-semibold text-subtle">404</p>
      <p className="text-muted">This page does not exist.</p>
      <Link href="/workspaces" className="text-sm font-medium text-primary hover:underline">
        Go to your workspaces
      </Link>
    </div>
  );
}
