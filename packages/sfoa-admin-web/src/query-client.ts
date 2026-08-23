import { QueryClient } from '@tanstack/react-query';

export function createAdminQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: (failureCount, error) => failureCount < 1 && !(isHttpError(error) && error.status < 500),
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

function isHttpError(error: unknown): error is Readonly<{ status: number }> {
  return typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number';
}
