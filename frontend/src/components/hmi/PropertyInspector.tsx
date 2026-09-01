import React, { useEffect, useMemo, useState } from 'react';
import { MousePointerSquareDashedIcon, Link2Icon, AlertTriangleIcon, ShapesIcon } from 'lucide-react';
import { HmiWidget } from '../../models/widget';
import { PlcVariable } from '../../models/plc';
import { useAppStore } from '../../context/AppStore';
import { catalogByKind } from './widgetCatalog';
import {
  partesDe,
  estiloDeParte,
  cambioDeParte,
  parteTocada,
  limpiarParte,
  type PropParte } from
'./partes';
import type { ParteId } from '../../models/widget';
import { customByKind } from './custom/registry';
import { panelBuiltIn } from './inspectores';
import {
  useSecciones,
  esWidgetDeNavegacion,
  GRUPO_POR_DEFECTO,
  VISTA_TODAS } from
'./custom/navegacion/store';
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
/** Damero: el modo universal de decir «aquí no hay color». */
const DAMERO: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg,#cbd5e1 25%,transparent 25%,transparent 75%,#cbd5e1 75%),' +
    'linear-gradient(45deg,#cbd5e1 25%,transparent 25%,transparent 75%,#cbd5e1 75%)',
  backgroundSize: '8px 8px',
  backgroundPosition: '0 0, 4px 4px',
  backgroundColor: '#fff'
};

/**
 * El fondo de un widget, que puede ser un color O NO EXISTIR.
 *
 * POR QUÉ NO ES UN <input type="color"> A SECAS
 * Porque ese control no sabe decir «ninguno». No tiene ese valor: siempre
 * devuelve un color. La versión anterior lo disimulaba cargándole #ffffff
 * cuando el fondo era transparente, y ahí estaba la trampa — un control
 * cargado con un valor que no es el real. Bastaba con que emitiera un solo
 * evento (abrirlo y cerrarlo sin elegir nada ya cuenta) para que ese #ffffff
 * de mentira se guardara como fondo de verdad.
 *
 * Y el sitio donde peor se nota es un widget ZIP: el fondo blanco no tapa su
 * dibujo, así que no se ve nada raro salvo un marco blanco alrededor, y desde
 * fuera parece que el ZIP viene con fondo. No hay forma de adivinar que lo
 * puso el editor.
 *
 * LA SOLUCIÓN: SIN FONDO NO HAY SELECTOR DE COLOR.
 * Cuando no hay fondo se dibuja un damero, y para poner uno hay que pedirlo.
 * Es un clic más, y a cambio es imposible acabar con un fondo que no elegiste.
 */
function ControlFondo({
  valor,
  onChange,
  t




}: {valor: any;onChange: (v: any) => void;t: (k: string) => string;}) {
  const sinFondo = !valor || valor === 'transparent';

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {t('insp.bgColor')}
      </span>

      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-slate-400">
          {sinFondo ? t('insp.noBg') : valor}
        </span>

        {sinFondo ?
        // Gris neutro y no blanco: al añadir un fondo se tiene que VER que se
        // añadió. Un blanco sobre el lienzo claro no se distingue de no tener
        // fondo, que es justo la confusión que se quiere evitar.
        <button
          type="button"
          onClick={() => onChange('#cbd5e1')}
          title="Poner un color de fondo"
          aria-label="Poner un color de fondo"
          className="h-7 w-9 rounded border border-slate-200 transition hover:border-siemens dark:border-navy-slate"
          style={DAMERO} /> :


        <>
            <input
            type="color"
            value={valor}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-9 cursor-pointer rounded border border-slate-200 bg-white p-0.5 dark:border-navy-slate dark:bg-navy" />

            <button
            type="button"
            onClick={() => onChange('transparent')}
            title="Quitar el fondo"
            aria-label="Quitar el fondo"
            className="rounded border border-slate-200 px-1.5 py-1 text-[11px] text-slate-400 transition hover:border-siemens hover:text-siemens dark:border-navy-slate">
              ∅
            </button>
          </>
        }
      </div>
    </div>);

}

/**
 * Control de una propiedad de estilo.
 *
 * Se elige solo según la propiedad, así que agregar una parte nueva en
 * partes.ts no obliga a tocar el Inspector: basta con listarla en sus `props`.
 */
function ControlProp({
  prop,
  valor,
  onChange,
  t




}: {prop: PropParte;valor: any;onChange: (v: any) => void;t: (k: string) => string;}) {
  switch (prop) {
    case 'background':
      return <ControlFondo valor={valor} onChange={onChange} t={t} />;

    case 'color':
      return <ColorField label={t('insp.color')} value={valor ?? '#009999'} onChange={onChange} />;
    case 'borderColor':
      return <ColorField label={t('insp.borderColor')} value={valor ?? '#94a3b8'} onChange={onChange} />;
    case 'borderWidth':
      return <SliderField label={t('insp.borderWidth')} value={valor ?? 0} min={0} max={8} onChange={onChange} suffix="px" />;
    case 'borderRadius':
      return <SliderField label={t('insp.borderRadius')} value={valor ?? 0} min={0} max={40} onChange={onChange} suffix="px" />;
    case 'opacity':
      return (
        <SliderField
          label={t('insp.opacity')}
          value={Math.round((valor ?? 1) * 100)}
          min={10}
          max={100}
          onChange={(v) => onChange(v / 100)}
          suffix="%" />);

    case 'fontSize':
      return <SliderField label={t('insp.textSize')} value={valor ?? 14} min={8} max={72} onChange={onChange} suffix="px" />;
    case 'bold':
      return <ToggleField label={t('insp.bold')} value={!!valor} onChange={onChange} />;
    case 'align':
      return (
        <SelectField
          label={t('insp.align')}
          value={valor ?? 'center'}
          options={[
          { label: t('insp.alignLeft'), value: 'left' },
          { label: t('insp.alignCenter'), value: 'center' },
          { label: t('insp.alignRight'), value: 'right' }]
          }
          onChange={onChange} />);

    default:
      return null;
  }
}

/** Botón de sección: se ve de un vistazo en cuál está y se cambia de un clic. */
function BotonSeccion({
  activo,
  onClick,
  titulo,
  children



}: {activo: boolean;onClick: () => void;titulo: string;children: React.ReactNode;}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={titulo}
      className={`rounded-lg px-2.5 py-1 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
      activo ?
      'bg-siemens text-white' :
      'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-navy-slate/50 dark:text-slate-400 dark:hover:bg-navy-slate'}`
      }>
      {children}
    </button>);

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

  // Secciones que declara el Menú Lateral del lienzo. Llena el desplegable
  // de "Vista".
  //
  // Va ANTES del return de "sin selección" a propósito: un hook no puede
  // quedar detrás de un return condicional, o React lo llamaría unas veces
  // sí y otras no y reventaría el orden de los hooks.
  const seccionesNav = useSecciones(GRUPO_POR_DEFECTO);

  // Parte cuyo estilo se está editando. Arriba del return temprano porque es
  // un hook: detrás de un return condicional React se perdería el orden.
  const [parteSel, setParteSel] = useState<ParteId>('box');

  // Cada tipo de widget expone las suyas, así que al cambiar de widget la
  // parte elegida puede no existir en el nuevo. Sin esto, seleccionar un
  // rectángulo después de un menú dejaba el panel en blanco.
  const partes = useMemo(
    () => partesDe(widget?.kind ?? ''),
    [widget?.kind]
  );
  useEffect(() => {
    if (!partes.some((p) => p.id === parteSel)) setParteSel(partes[0].id);
  }, [partes, parteSel]);

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
  // Panel propio del tipo de widget, si lo trae.
  //
  // Hay dos sitios donde puede estar declarado, y no por capricho: los
  // widgets custom lo traen en su propia definicion (`CustomWidgetDef`),
  // mientras que los built-in no son entradas de un registry sino ramas de
  // un `switch`, asi que el suyo vive en un mapa aparte (inspectores/).
  // El primero que lo usa es la Imagen, que sin panel no tiene forma de
  // saber que imagen mostrar.
  const custom = customByKind(widget.kind);
  const propio = custom?.inspector
    ? { titulo: custom.label, render: custom.inspector }
    : panelBuiltIn(widget.kind);

  // Mayuscula a proposito: se renderiza como <PanelPropio />, NO se llama
  // como propio.render(...).
  //
  // Parece lo mismo y no lo es. Llamarlo mete sus hooks DENTRO de este
  // componente, asi que al seleccionar un widget con panel el Inspector
  // pasaba de 5 hooks a 7 entre un render y el siguiente: «Rendered more
  // hooks than during the previous render». Funciono mientras los paneles
  // no usaban hooks; el de la Imagen usa useRef y useState y lo destapo.
  //
  // Como elemento, React le da su propia identidad y sus hooks son suyos.
  const PanelPropio = propio?.render;

  // El propio menú y el panel de sección no eligen sección: van fijos.
  const esNavegacion = esWidgetDeNavegacion(widget.kind);

  const defParte = partes.find((p) => p.id === parteSel) ?? partes[0];
  const estiloActual = estiloDeParte(widget, defParte.id);

  /**
   * Guarda una propiedad de la parte donde toque.
   *
   * `cambioDeParte` decide el destino: caja y texto siguen escribiendo en
   * `widget.style` (donde ya vivían), el resto en `widget.partes`.
   */
  const aplicarProp = (prop: PropParte, valor: any) => {
    const cambio = cambioDeParte(widget, defParte.id, prop, valor);
    if (cambio.style) onStyleChange(cambio.style);
    if (cambio.partes) onChange({ partes: cambio.partes });
  };

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

      {/* ── SECCIÓN A LA QUE PERTENECE ───────────────────────────
          Va lo primero, y con botones en vez de desplegable, porque es lo
          que más se toca cuando hay navegación: se ve de un golpe en cuál
          está y se cambia con un clic. Metido abajo y como <select> pasaba
          desapercibido, y entonces todo quedaba en "En todas" y la
          navegación parecía no funcionar.

          Aparece solo si hay un Menú Lateral con secciones declaradas: sin
          navegación montada este campo no significaría nada. */}
      {seccionesNav.length > 0 && !esNavegacion &&
      <Section title="Sección">
        <div className="flex flex-wrap gap-1">
          <BotonSeccion
            activo={!widget.vista}
            onClick={() => onChange({ vista: VISTA_TODAS })}
            titulo="Se ve en todas las secciones">
            En todas
          </BotonSeccion>
          {seccionesNav.map((s) =>
          <BotonSeccion
            key={s.id}
            activo={widget.vista === s.id}
            onClick={() => onChange({ vista: s.id })}
            titulo={`Solo se ve en «${s.label || s.id}»`}>
            {s.label || s.id}
          </BotonSeccion>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-slate-400">
          {widget.vista ?
          'Solo aparece cuando esa sección está abierta.' :
          'Aparece en todas las secciones. Útil para un logo o una barra de estado.'}
        </p>
      </Section>
      }

      {esNavegacion &&
      <Section title="Sección">
        <p className="text-[11px] leading-relaxed text-slate-400">
          Este widget se ve siempre, en todas las secciones. Si perteneciera a
          una, desaparecería al navegar fuera de ella y te quedarías sin forma
          de volver.
        </p>
      </Section>
      }

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

      {/* Solo si el widget lee variables. Los que declaran
          `accepts: []` (menú, panel de sección, formas decorativas) no
          usan ninguna, y ofrecerles el desplegable era ofrecer algo que
          no hace nada. */}
      {leeVariables &&
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
      }

      {/* ── Panel propio del widget ──────────────────────────────
          Solo aparece si su tipo trae uno. Es donde el Menú Lateral declara
          sus secciones y donde la Imagen sube su archivo. */}
      {propio && PanelPropio &&
      <Section title={propio.titulo}>
        {/* `key` con el id: al saltar de un widget a otro del mismo tipo se
            monta un panel nuevo. Sin esto, el mensaje de error de una imagen
            que no cargo seguiria en pantalla al seleccionar la siguiente. */}
        <PanelPropio
          key={widget.id}
          widget={widget}
          config={widget.config ?? {}}
          setConfig={(config) => onChange({ config })} />
      </Section>
      }

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

      {/* ── ESTILO POR PARTES ────────────────────────────────────
          Antes había un bloque «Apariencia» con un solo color, un solo
          tamaño de letra y un solo fondo para todo el widget. En cuanto un
          widget tiene más de un elemento eso se queda corto: en el Menú
          Lateral, ¿«color» era el fondo del botón activo o el del texto?
          Los dos a la vez, quisieras o no.

          Ahora eliges la parte arriba y editas solo lo suyo, que es como lo
          resuelve el IQ-Styling de WebIQ. Cada widget declara qué partes
          tiene (partes.ts), así que a un rectángulo no se le ofrece
          «tamaño de letra». */}
      <Section title={t('insp.appearance')}>
        {/* Selector de parte. Con una sola no se dibuja: sería un botón
            inútil ocupando sitio. */}
        {partes.length > 1 &&
        <div className="flex flex-wrap gap-1">
          {partes.map((p) =>
          <button
            key={p.id}
            type="button"
            onClick={() => setParteSel(p.id)}
            title={`Estilo de: ${p.label}`}
            className={`relative rounded-lg px-2.5 py-1 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-siemens/40 ${
            parteSel === p.id ?
            'bg-siemens text-white' :
            'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-navy-slate/50 dark:text-slate-400 dark:hover:bg-navy-slate'}`
            }>
            {p.label}
            {/* Punto: esta parte tiene algo cambiado a mano. WebIQ hace lo
                mismo, y evita tener que abrir una por una para saber dónde
                tocaste algo. */}
            {parteTocada(widget, p.id) &&
            <span className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${
              parteSel === p.id ? 'bg-white' : 'bg-siemens'}`
              } />
            }
          </button>
          )}
        </div>
        }

        {defParte.props.map((prop) =>
        <ControlProp
          key={prop}
          prop={prop}
          valor={(estiloActual as any)[prop]}
          onChange={(v) => aplicarProp(prop, v)}
          t={t} />
        )}

        {/* Restablecer: solo aparece si hay algo que restablecer, y solo en
            las partes que guardan aparte (caja y texto viven en el estilo
            de siempre y no tienen "override" que quitar). */}
        {parteTocada(widget, parteSel) &&
        <button
          type="button"
          onClick={() => onChange({ partes: limpiarParte(widget, parteSel) })}
          className="w-full rounded-lg border border-dashed border-slate-300 py-1.5 text-[11px] font-semibold text-slate-400 transition hover:border-state-error hover:text-state-error dark:border-navy-slate">
          Restablecer «{defParte.label}»
        </button>
        }
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