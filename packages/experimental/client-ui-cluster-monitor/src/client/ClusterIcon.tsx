/** Decorative occupant for the Cluster jobs sidebar entry. */
import { IconDataOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the data glyph at the size the sidebar asks for; the sidebar owns the accessible label.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function ClusterIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconDataOutlineRegular size={size} />
}
