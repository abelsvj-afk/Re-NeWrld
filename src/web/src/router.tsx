import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
  Outlet,
  Navigate,
} from '@tanstack/react-router';
import { useAuth } from './stores/auth';
import { LoginPage } from './pages/LoginPage';
import { ReaderPage } from './pages/ReaderPage';
import { CreatorDashboard } from './pages/CreatorDashboard';

function RootLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-void flex items-center justify-center">
        <div className="text-ink-dim animate-pulse">Entering the world…</div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" />;
  return <Outlet />;
}

const rootRoute = createRootRoute({ component: RootLayout });

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: function Index() {
    const { user } = useAuth();
    if (user?.role === 'creator') return <Navigate to="/creator" />;
    return <Navigate to="/read" />;
  },
});

const readerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/read',
  component: ReaderPage,
});

const readerSessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/read/$sessionId',
  component: ReaderPage,
});

const creatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/creator',
  component: CreatorDashboard,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  indexRoute,
  readerRoute,
  readerSessionRoute,
  creatorRoute,
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
