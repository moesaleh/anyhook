import { NextResponse, type NextRequest } from "next/server";

// Routes that don't require a session cookie
const PUBLIC_PATHS = new Set<string>(["/login", "/register"]);

// Cookie name MUST match the backend (src/subscription-management/auth.js
// COOKIE_NAME constant).
const SESSION_COOKIE = "anyhook_session";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const session = request.cookies.get(SESSION_COOKIE);
  const isPublic = PUBLIC_PATHS.has(pathname);

  // Block access to protected pages without a cookie. Note: we only check
  // for cookie presence, not validity — actual validation happens server-side
  // on every API call. This is a fast UX gate, not the security boundary.
  if (!session && !isPublic) {
    const loginUrl = new URL("/login", request.url);
    if (pathname !== "/") {
      loginUrl.searchParams.set("next", pathname);
    }
    return NextResponse.redirect(loginUrl);
  }

  // If a logged-in user hits /login or /register, send them to the dashboard
  if (session && isPublic) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next internals and static files
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)$).*)",
  ],
};
