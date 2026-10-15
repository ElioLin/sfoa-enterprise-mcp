import { useOutletContext } from 'react-router-dom';
import type { AdminSessionDto } from '@sfoa/control-plane';

/**
 * The signed-in session, published by the protected layout to every child route. The Console
 * reads it for the modules it may render; the Admin API resolves and enforces the same list for
 * every request, so this copy is presentation state only.
 */
export function useSession(): AdminSessionDto {
  return useOutletContext<AdminSessionDto>();
}
