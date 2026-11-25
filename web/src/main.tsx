import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router';
import { router } from './router';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 2000 } },
});

function usePrefersDark() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const [dark, setDark] = useState(mq.matches);
  useEffect(() => {
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [mq]);
  return dark;
}

function Root() {
  const dark = usePrefersDark();
  return (
    <ConfigProvider
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: dark ? '#7c8cff' : '#4f5bd5',
          colorInfo: dark ? '#7c8cff' : '#4f5bd5',
          borderRadius: 8,
          fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
          fontFamilyCode: "ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace",
          colorBgLayout: dark ? '#0d0f14' : '#f4f5f8',
          colorBgContainer: dark ? '#151821' : '#ffffff',
          colorBorderSecondary: dark ? '#242838' : '#e9ebf0',
        },
        components: {
          Layout: { siderBg: dark ? '#10131a' : '#ffffff', headerBg: 'transparent', headerHeight: 56, headerPadding: '0 24px' },
          Menu: { itemBg: 'transparent', subMenuItemBg: 'transparent', itemBorderRadius: 6, itemHeight: 36, itemMarginInline: 8 },
          Table: { headerBg: 'transparent', rowHoverBg: dark ? '#1c2030' : '#f5f6fb', cellPaddingBlockSM: 10 },
          Card: { headerFontSize: 14 },
        },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
