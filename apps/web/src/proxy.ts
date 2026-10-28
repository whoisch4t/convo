import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic redirect only: it checks that a session cookie exists, not that it is valid.
 * The API verifies every request, and the client sends people to /login when it returns 401.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = request.cookies.has('cv_refresh') || request.cookies.has('cv_access');
  const isAuthPage = pathname === '/login' || pathname === '/register';

  if (!isAuthPage && !hasSession) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname + search);
    return NextResponse.redirect(url);
  }
  if (isAuthPage && hasSession) return NextResponse.redirect(new URL('/workspaces', request.url));
  return NextResponse.next();
}

export const config = { matcher: ['/workspaces/:path*', '/w/:path*', '/login', '/register'] };
