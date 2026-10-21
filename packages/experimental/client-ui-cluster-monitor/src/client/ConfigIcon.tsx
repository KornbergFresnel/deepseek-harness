/** Decorative occupant for the Cluster configuration sidebar entry. */
import { IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the settings glyph at the size the sidebar asks for; the sidebar owns the accessible label.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function ConfigIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconSettingsOutlineRegular size={size} />
}
