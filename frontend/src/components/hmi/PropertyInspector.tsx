import React from 'react';
import { MousePointerSquareDashedIcon, Link2Icon } from 'lucide-react';
import { HmiWidget } from '../../models/widget';
import { PlcVariable } from '../../models/plc';
import { useAppStore } from '../../context/AppStore';
import {
  TextField,
  NumberField,
  ColorField,
  ToggleField,
  SliderField,
  SelectField } from
'../ui/Field';
interface Props {
  widget: HmiWidget | null;
  selectedVariables: PlcVariable[];
  onChange: (patch: Partial<HmiWidget>) => void;
  onStyleChange: (patch: Partial<HmiWidget['style']>) => void;
  onDelete: () => void;
}
function Section({
  title,
  children



}: {title: string;children: React.ReactNode;}) {
  return (
    <div className="border-b border-slate-100 px-4 py-4 last:border-0 dark:border-navy-slate">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {title}
      </p>
      <div className="space-y-3">{children}</div>
    </div>);

}
export function PropertyInspector({
  widget,
  selectedVariables,
  onChange,
  onStyleChange,
  onDelete
}: Props) {
  const { t, widgetLabel } = useAppStore();
  if (!widget) {
    return (
      <aside className="mp-scroll mp-scroll-dark flex w-72 shrink-0 flex-col items-center justify-center overflow-auto border-l border-slate-200 bg-white p-6 text-center dark:border-navy-slate dark:bg-navy-soft">
        <MousePointerSquareDashedIcon className="mb-3 h-8 w-8 text-slate-300 dark:text-slate-600" />
        <p className="text-sm font-medium text-slate-500 dark:text-slate-300">
          {t('insp.noSelection')}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {t('insp.noSelectionHint')}
        </p>
      </aside>);

  }
  const varOptions = [
  {
    label: t('insp.none'),
    value: ''
  },
  ...selectedVariables.map((v) => ({
    label: `${v.name} (${v.type})`,
    value: v.id
  }))];

  return (
    <aside className="mp-scroll mp-scroll-dark flex w-72 shrink-0 flex-col overflow-auto border-l border-slate-200 bg-white dark:border-navy-slate dark:bg-navy-soft">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-navy-slate">
        <div>
          <h2 className="text-sm font-bold text-navy dark:text-slate-100">
            {t('insp.title')}
          </h2>
          <p className="text-xs text-slate-400">{widgetLabel(widget.kind)}</p>
        </div>
        <button
          onClick={onDelete}
          className="rounded-md px-2 py-1 text-xs font-medium text-state-error transition hover:bg-red-50 dark:hover:bg-state-error/10">
          
          {t('insp.delete')}
        </button>
      </div>

      <Section title={t('insp.identity')}>
        <TextField
          label={t('insp.name')}
          value={widget.name}
          onChange={(v) =>
          onChange({
            name: v
          })
          } />
        
        <TextField
          label={t('insp.text')}
          value={widget.text}
          onChange={(v) =>
          onChange({
            text: v
          })
          } />
        
      </Section>

      <Section title={t('insp.binding')}>
        <SelectField
          label={t('insp.associatedVar')}
          value={widget.variableId ?? ''}
          options={varOptions}
          onChange={(v) =>
          onChange({
            variableId: v === '' ? null : v
          })
          } />
        
        <div className="flex items-center gap-1.5 rounded-lg bg-siemens-50 px-2.5 py-2 text-[11px] text-siemens-700 dark:bg-siemens/10 dark:text-siemens-200">
          <Link2Icon className="h-3.5 w-3.5" />
          {selectedVariables.length} {t('insp.varsAvailable')}
        </div>
      </Section>

      <Section title={t('insp.geometry')}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label={t('insp.posX')}
            value={widget.x}
            onChange={(v) =>
            onChange({
              x: v
            })
            } />
          
          <NumberField
            label={t('insp.posY')}
            value={widget.y}
            onChange={(v) =>
            onChange({
              y: v
            })
            } />
          
          <NumberField
            label={t('insp.width')}
            value={widget.width}
            onChange={(v) =>
            onChange({
              width: v
            })
            } />
          
          <NumberField
            label={t('insp.height')}
            value={widget.height}
            onChange={(v) =>
            onChange({
              height: v
            })
            } />
          
        </div>
        <SliderField
          label={t('insp.rotation')}
          value={widget.style.rotation}
          min={0}
          max={360}
          onChange={(v) =>
          onStyleChange({
            rotation: v
          })
          }
          suffix="°" />
        
      </Section>

      <Section title={t('insp.appearance')}>
        <ColorField
          label={t('insp.color')}
          value={widget.style.color}
          onChange={(v) =>
          onStyleChange({
            color: v
          })
          } />
        
        <ColorField
          label={t('insp.bgColor')}
          value={widget.style.background}
          onChange={(v) =>
          onStyleChange({
            background: v
          })
          } />
        
        <ColorField
          label={t('insp.borderColor')}
          value={widget.style.borderColor}
          onChange={(v) =>
          onStyleChange({
            borderColor: v
          })
          } />
        
        <SliderField
          label={t('insp.borderRadius')}
          value={widget.style.borderRadius}
          min={0}
          max={40}
          onChange={(v) =>
          onStyleChange({
            borderRadius: v
          })
          }
          suffix="px" />
        
        <SliderField
          label={t('insp.borderWidth')}
          value={widget.style.borderWidth}
          min={0}
          max={8}
          onChange={(v) =>
          onStyleChange({
            borderWidth: v
          })
          }
          suffix="px" />
        
        <SliderField
          label={t('insp.opacity')}
          value={Math.round(widget.style.opacity * 100)}
          min={10}
          max={100}
          onChange={(v) =>
          onStyleChange({
            opacity: v / 100
          })
          }
          suffix="%" />
        
      </Section>

      <Section title={t('insp.text')}>
        <SliderField
          label={t('insp.textSize')}
          value={widget.style.fontSize}
          min={8}
          max={48}
          onChange={(v) =>
          onStyleChange({
            fontSize: v
          })
          }
          suffix="px" />
        
        <ToggleField
          label={t('insp.bold')}
          value={widget.style.bold}
          onChange={(v) =>
          onStyleChange({
            bold: v
          })
          } />
        
        <SelectField
          label={t('insp.align')}
          value={widget.style.align}
          options={[
          {
            label: t('insp.alignLeft'),
            value: 'left'
          },
          {
            label: t('insp.alignCenter'),
            value: 'center'
          },
          {
            label: t('insp.alignRight'),
            value: 'right'
          }]
          }
          onChange={(v) =>
          onStyleChange({
            align: v
          })
          } />
        
      </Section>

      <Section title={t('insp.state')}>
        <ToggleField
          label={t('insp.visible')}
          value={widget.visible}
          onChange={(v) =>
          onChange({
            visible: v
          })
          } />
        
        <ToggleField
          label={t('insp.enabled')}
          value={widget.enabled}
          onChange={(v) =>
          onChange({
            enabled: v
          })
          } />
        
      </Section>
    </aside>);

}