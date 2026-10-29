import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { App } from './App';
import { BoardProvider } from './hooks/board';
import { RunsProvider } from './hooks/runs';
import { StreamProvider } from './hooks/stream';
import { ThemeProvider } from './hooks/useTheme';
import { Board } from './routes/Board';
import { Config } from './routes/Config';
import { Console } from './routes/Console';
import { Cost } from './routes/Cost';
import { PrReview } from './routes/PrReview';
import { V2Shell } from './v2/Shell';
import './index.css';

/**
 * Provider order matters:
 *   Stream  — one EventSource for the whole app
 *   Board   — one /api/state subscription, refetched on every `state` frame
 *   Runs    — every POST action; needs board state to clear optimistic launches
 * Routes mirror the legacy URLs exactly (`/`, `/board`, `/cost`, `/pr-review`, `/config`)
 * so bookmarks survive the migration; server.mjs serves them via the SPA fallback.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider delayDuration={250}>
        <StreamProvider>
          <BoardProvider>
            <RunsProvider>
              <BrowserRouter>
                <Routes>
                  {/* v2: the Slack-style workspace, same providers and API, alongside v1. */}
                  <Route path="v2" element={<Navigate to="/v2/needs-you" replace />} />
                  <Route path="v2/:channel" element={<V2Shell />} />
                  <Route element={<App />}>
                    <Route index element={<Console />} />
                    <Route path="board" element={<Board />} />
                    <Route path="cost" element={<Cost />} />
                    <Route path="pr-review" element={<PrReview />} />
                    <Route path="config" element={<Config />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Routes>
              </BrowserRouter>
            </RunsProvider>
          </BoardProvider>
        </StreamProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
