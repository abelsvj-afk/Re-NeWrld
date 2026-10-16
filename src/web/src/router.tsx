import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { useAuth } from './stores/auth';
import { getViewMode } from './lib/view-mode';
import { LoginPage } from './pages/LoginPage';
import { ReaderPage } from './pages/ReaderPage';
import { CreatorDashboard } from './pages/CreatorDashboard';
import { SceneEditorPage } from './pages/SceneEditorPage';
import { PublishPage } from './pages/PublishPage';

function RootLayout() {
  return <Outlet />;
}

const rootRoute = createRootRoute({ component: RootLayout });

// Helper to require auth — relies on hydrate() having run in Boot.
// Cookie is HTTP-only so we can't check it directly; the me() call validates.
function requireAuth() {
  const { user, loading } = useAuth.getState();
  // If still hydrating, allow the route — Boot will redirect if unauthenticated
  if (loading) return;
  if (!user) throw redirect({ to: '/login' });
}

// Helper to redirect authenticated users away from login
function redirectIfAuthenticated() {
  const { user, loading } = useAuth.getState();
  if (loading) return;
  if (user) throw redirect({ to: '/' });
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  beforeLoad: redirectIfAuthenticated,
  component: LoginPage,
});

const signinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  beforeLoad: () => { throw redirect({ to: '/login' }); },
  component: LoginPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: () => {
    requireAuth();
    // H-UX3: creators who chose Reader view land on /read (one-way redirect,
    // no loop — /read never redirects back). Explicit /creator always shows studio.
    const { user, loading } = useAuth.getState();
    if (!loading && user?.role === 'creator' && getViewMode() === 'reader') {
      throw redirect({ to: '/read' });
    }
  },
  component: function Index() {
    const { user, loading } = useAuth();
    if (loading) return <div className="min-h-screen bg-void flex items-center justify-center"><div className="text-ink-dim animate-pulse">Loading…</div></div>;
    if (user?.role === 'creator') return <CreatorDashboard />;
    return <ReaderPage />;
  },
});

const readerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/read',
  beforeLoad: requireAuth,
  component: ReaderPage,
});

const readerSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/read/$sessionId',
  beforeLoad: requireAuth,
  component: ReaderPage,
});

// Helper to require creator role
function requireCreator() {
  const { user, loading } = useAuth.getState();
  if (loading) return;
  if (!user) throw redirect({ to: '/login' });
  if (user.role !== 'creator') throw redirect({ to: '/read' });
}

const creatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creator',
  beforeLoad: requireCreator,
  component: CreatorDashboard,
});

const sceneEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creator/worlds/$worldId/scenes',
  beforeLoad: requireCreator,
  component: SceneEditorPage,
});

const publishRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creator/worlds/$worldId/publish',
  beforeLoad: requireCreator,
  component: PublishPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signinRoute,
  indexRoute,
  readerRoute,
  readerSessionRoute,
  creatorRoute,
  sceneEditorRoute,
  publishRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}
