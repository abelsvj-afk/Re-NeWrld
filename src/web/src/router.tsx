import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { useAuth } from './stores/auth';
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

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: requireAuth,
  component: function Index() {
    const { user } = useAuth();
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

const creatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creator',
  beforeLoad: requireAuth,
  component: CreatorDashboard,
});

const sceneEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creator/worlds/$worldId/scenes',
  beforeLoad: requireAuth,
  component: SceneEditorPage,
});

const publishRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creator/worlds/$worldId/publish',
  beforeLoad: requireAuth,
  component: PublishPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
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
