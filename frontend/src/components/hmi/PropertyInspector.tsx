import React from 'react';
import { MousePointerSquareDashedIcon, Link2Icon, AlertTriangleIcon, ShapesIcon } from 'lucide-react';
import { HmiWidget } from '../../models/widget';
import { PlcVariable } from '../../models/plc';
import { useAppStore } from '../../context/AppStore';
import { catalogByKind } from './widgetCatalog';
import {
  usaVariable,
  avisoIncompatible,
  describirAceptados,
  repartirPorCompatibilidad } from
'../../utils/widgetBinding';
import {
  TextField,
  NumberField,
  ColorField,
  ToggleField,
  SliderField,
  SelectField,
  SelectGroupField } from
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
  // ── Compatibilidad de tipos ───────────────────────────────────
  //
  // El widget declara qué tipos sabe representar (widgetCatalog.ts para los
  // que vienen con la app, widget.json para los subidos por ZIP). Con eso las
  // variables se reparten en dos grupos del desplegable.
  //
  // Las incompatibles NO se ocultan: `mapOpcType()` deduce el tipo del nombre
  // que reporta el OPC UA y ante un nombre raro cae en 'string' por descarte.
  // Si eso escondiera la variable, el usuario se quedaría sin poder usar la
  // suya y sin saber por qué. Se separan, se avisa, y decide él.
  const acepta = catalogByKind(widget.kind)?.accepts;
  const leeVariables = usaVariable(acepta);
  const { compatibles, otras } = repartirPorCompatibilidad(selectedVariables, acepta);

  const opcion = (v: PlcVariable) => ({
    label: `${v.name} (${v.type})`,
    value: v.id
  });

  const varGroups = [
  { label: '', options: [{ label: t('insp.none'), value: '' }] },
  { label: t('insp.varsCompatible'), options: compatibles.map(opcion) },
  { label: t('insp.varsOther'), options: otras.map(opcion) }];

  // Variable enlazada ahora mismo, para avisar si no calza. Puede venir de un
  // diseño guardado antes de que existiera esta validación.
  const variableActual = selectedVariables.find((v) => v.id === widget.variableId);
  const aviso = avisoIncompatible(acepta, variableActual);

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
        <SelectGroupField
          label={t('insp.associatedVar')}
          value={widget.variableId ?? ''}
          groups={varGroups}
          onChange={(v) =>
          onChange({
            variableId: v === '' ? null : v
          })
          } />
        
        {/* Qué espera este widget. Se muestra siempre: es la respuesta a
            "¿por qué mi variable salió en el grupo de abajo?". */}
        <div className="flex items-start gap-1.5 rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
          <ShapesIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">
            {t('insp.widgetAccepts')} <b>{describirAceptados(acepta)}</b>
          </span>
        </div>

        {/* Aviso, no bloqueo. */}
        {aviso &&
        <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-400">
            <AlertTriangleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0">{aviso}</span>
          </div>
        }

        {leeVariables &&
        <div className="flex items-center gap-1.5 rounded-lg bg-siemens-50 px-2.5 py-2 text-[11px] text-siemens-700 dark:bg-siemens/10 dark:text-siemens-200">
            <Link2Icon className="h-3.5 w-3.5" />
            {compatibles.length}/{selectedVariables.length} {t('insp.varsCompatibleCount')}
          </div>
        }
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
        
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              {t('insp.bgColor')}
            </span>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-slate-400">
                {widget.style.background === 'transparent' ? 'ninguno' : widget.style.background}
              </span>
              <input
                type="color"
                value={widget.style.background !== 'transparent' && widget.style.background.length === 7 ? widget.style.background : '#ffffff'}
                onChange={(e) => onStyleChange({ background: e.target.value })}
                className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5 dark:border-navy-slate dark:bg-navy" />
            </div>
          </label>
          <button
            onClick={() => onStyleChange({ background: 'transparent' })}
            title="Sin fondo"
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded border text-xs transition ${
              widget.style.background === 'transparent'
                ? 'border-siemens bg-siemens/10 text-siemens'
                : 'border-slate-200 text-slate-400 hover:border-siemens/40 dark:border-navy-slate'
            }`}>
            ∅
          </button>
        </div>
        
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