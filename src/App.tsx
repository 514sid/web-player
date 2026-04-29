import { createBrowserRouter, RouterProvider } from "react-router-dom";
import PlayerPage from "./pages/PlayerPage";
import ManagePage from "./pages/ManagePage";

// Strip trailing slash so React Router gets e.g. "/repo-name" not "/repo-name/"
const basename = import.meta.env.BASE_URL.replace(/\/$/, "") || "/";

const router = createBrowserRouter([
  { path: "/",       element: <PlayerPage /> },
  { path: "/manage", element: <ManagePage /> },
], { basename });

export default function App() {
  return <RouterProvider router={router} />;
}
