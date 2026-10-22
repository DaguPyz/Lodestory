import {Button, Dialog, DialogActions, DialogClose, Icon, IconButton, SearchField, Select} from "@lodestory/ui";
import {createRef} from "react";
import type {
  ButtonProps,
  DialogActionsProps,
  DialogCloseProps,
  DialogProps,
  IconButtonProps,
  IconName,
  IconSize,
  SearchFieldProps,
  SelectOption,
  SelectProps,
} from "@lodestory/ui";

const buttonProps: ButtonProps = {variant: "danger", type: "submit", "aria-pressed": true, selectionActive: false};
const iconButtonProps: IconButtonProps = {label: "关闭", disabled: false, focusSurface: "inverse"};
const searchFieldProps: SearchFieldProps = {label: "搜索项目", value: "", focusSurface: "neutral", "aria-invalid": true, onChange() {}};
const selectOptions: readonly SelectOption[] = [
  {value: "", label: "项目根目录"},
  {value: "chapter", label: "章节", disabled: true},
];
const selectProps: SelectProps = {
  value: "",
  options: selectOptions,
  onValueChange(value) { void value; },
  name: "documentParent",
  "aria-labelledby": "document-parent-label",
  ref: createRef<HTMLButtonElement>(),
};
const dialogProps: DialogProps = {
  open: false,
  onOpenChange() {},
  title: "通用弹框",
  description: <span>简短说明</span>,
  busy: false,
  initialFocus: createRef<HTMLElement>(),
  finalFocus: createRef<HTMLElement>(),
  children: <p>内容</p>,
};
const closeRef = createRef<HTMLButtonElement>();
const actionsProps: DialogActionsProps = {id: "dialog-actions", role: "group"};
const closeProps: DialogCloseProps = {ref: closeRef, variant: "secondary", disabled: false};
const iconName: IconName = "chevronRight";
const iconSize: IconSize = "brand";

export const components = [
  <Button {...buttonProps}>保存</Button>,
  <IconButton {...iconButtonProps}><Icon name="close" /></IconButton>,
  <SearchField {...searchFieldProps} />,
  <Select {...selectProps} />,
  <Dialog {...dialogProps} />,
  <DialogActions {...actionsProps}>
    <DialogClose {...closeProps}>取消</DialogClose>
  </DialogActions>,
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
// @ts-expect-error className is managed by DialogActions
const invalidDialogActions = <DialogActions className="host-class" />;
// @ts-expect-error DialogClose owns its button type
const invalidDialogClose = <DialogClose type="submit">提交</DialogClose>;
// @ts-expect-error Dialog title is required for accessible naming
const invalidDialog = <Dialog open onOpenChange={() => {}}><p>无标题</p></Dialog>;
// @ts-expect-error className is managed by Select
const invalidSelectClass = <Select className="host-select" value="" options={[]} onValueChange={() => {}} />;
// @ts-expect-error style is managed by Select
const invalidSelectStyle = <Select style={{width: 200}} value="" options={[]} onValueChange={() => {}} />;
void [invalidButton, invalidIconButton, invalidIconName, invalidSurface,
  invalidDialogActions, invalidDialogClose, invalidDialog, invalidSelectClass, invalidSelectStyle];
