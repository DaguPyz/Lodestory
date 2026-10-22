import {Button, Icon, IconButton, SearchField} from "@lodestory/ui";
import type {ButtonProps, IconButtonProps, IconName, IconSize, SearchFieldProps} from "@lodestory/ui";

const buttonProps: ButtonProps = {variant: "danger", type: "submit", "aria-pressed": true, selectionActive: false};
const iconButtonProps: IconButtonProps = {label: "关闭", disabled: false, focusSurface: "inverse"};
const searchFieldProps: SearchFieldProps = {label: "搜索项目", value: "", focusSurface: "neutral", "aria-invalid": true, onChange() {}};
const iconName: IconName = "chevronRight";
const iconSize: IconSize = "brand";

export const components = [
  <Button {...buttonProps}>保存</Button>,
  <IconButton {...iconButtonProps}><Icon name="close" /></IconButton>,
  <SearchField {...searchFieldProps} />,
  <Icon name={iconName} size={iconSize} />,
];

// @ts-expect-error unsupported button variant
const invalidButton: ButtonProps = {variant: "custom"};
// @ts-expect-error focus surface describes the adjacent surface, not a theme ID
const invalidSurface: SearchFieldProps = {label: "搜索", focusSurface: "dark"};
// @ts-expect-error icon buttons require an accessible label
const invalidIconButton: IconButtonProps = {};
// @ts-expect-error icon names come from the component library's public set
const invalidIconName: IconName = "not-an-icon";
void [invalidButton, invalidIconButton, invalidIconName, invalidSurface];
