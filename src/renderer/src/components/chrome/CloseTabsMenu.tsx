import { useTranslation } from 'react-i18next'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'

/** tab 条通用右键菜单：关闭 / 关闭其他 / 关闭右侧 / 关闭所有（主机条与 shell 条复用） */
export function CloseTabsMenu({
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll
}: {
  onClose: () => void
  onCloseOthers: () => void
  onCloseRight: () => void
  onCloseAll: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ContextMenuContent className="w-36 border-line">
      <ContextMenuItem className="text-danger focus:text-danger" onClick={onClose}>
        {t('common.close')}
      </ContextMenuItem>
      <ContextMenuItem onClick={onCloseOthers}>{t('chrome.closeOthers')}</ContextMenuItem>
      <ContextMenuItem onClick={onCloseRight}>{t('chrome.closeRight')}</ContextMenuItem>
      <ContextMenuSeparator className="bg-line" />
      <ContextMenuItem onClick={onCloseAll}>{t('chrome.closeAll')}</ContextMenuItem>
    </ContextMenuContent>
  )
}
