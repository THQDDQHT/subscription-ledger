'use client';

import { useCallback, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';

interface SelectOption {
  value: string;
  label: string;
  description?: string;
}

interface SelectFieldProps {
  id?: string;
  name?: string;
  label: string;
  value?: string;
  defaultValue?: string;
  disabled?: boolean;
  options: SelectOption[];
  onValueChange?: (value: string) => void;
}

/** 页面内选择器；菜单挂在所属 dialog 内，避免被原生弹窗的顶层遮住。 */
export function SelectField({ id, name, label, value, defaultValue, disabled, options, onValueChange }: SelectFieldProps) {
  const [open, setOpen] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const attachTrigger = useCallback((node: HTMLButtonElement | null) => {
    setContainer(node?.closest('dialog') ?? null);
  }, []);

  return (
    <Select name={name} value={value} defaultValue={defaultValue} disabled={disabled} onValueChange={onValueChange} open={open} onOpenChange={setOpen}>
      <SelectTrigger id={id} ref={attachTrigger} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent container={container} aria-label={label} onEscapeKeyDown={(event) => {
        // 第一遍 Esc 只收起菜单，保留正在填写的弹窗。
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} description={option.description}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
