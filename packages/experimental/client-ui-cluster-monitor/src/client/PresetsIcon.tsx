/** Decorative occupant for the Job configurations sidebar entry. */
import { IconSlidersTwoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the sliders glyph at the size the sidebar asks for; the sidebar owns the accessible label.
 * @param props - the sidebar's icon share.
 * @returns decorative icon.
 */
export function PresetsIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconSlidersTwoOutlineRegular size={size} />
}
