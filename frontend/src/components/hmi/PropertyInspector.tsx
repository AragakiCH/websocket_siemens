import React, { useEffect, useMemo, useState } from 'react';
import {
  MousePointerSquareDashedIcon,
  Link2Icon,
  AlertTriangleIcon,
  ShapesIcon,
  PlusIcon,
  Trash2Icon } from
'lucide-react';
import { HmiWidget } from '../../models/widget';
import { PlcVariable, DataType } from '../../models/plc';
import {
  leerEnlaces,
  conEnlace,
  sinEnlace,
  renombrarEnlace,
  nombreLibre,
  validarNombreEnlace,
  type DeclaracionEnlace } from
'../../utils/enlaces';
import { formatValue } from '../../utils/format';
import {
  leerDinamicas,
  dinamicaNueva,
  PIDE_VALOR,
  type Dinamica,
  type TipoDinamica,
  type OperadorDinamica } from
'../../utils/dinamicas';
import { ColorTema } from './ColorTema';
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
import { customByKind, zipByKind } from './custom/registry';
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
// El control del FONDO y el de los colores es ahora el MISMO: `ColorTema`.
// Sabe decir «sin fondo» y sabe apuntar a un color del tema.
//
// Aquí vivía `ControlFondo`, y su motivo sigue vigente aunque el código se
// haya ido: un <input type="color"> NO sabe representar «ninguno». La versión
// que lo cargaba con #ffffff cuando el fondo era transparente enseñaba un
// valor falso, y bastaba con abrirlo y cerrarlo para guardar ese blanco de
// mentira. Donde peor se notaba era en un widget ZIP: el blanco no tapa su
// dibujo, solo deja un marco, y no hay forma de adivinar que lo puso el
// editor. Si algún día se vuelve a tocar esto, la regla es la de entonces:
// sin fondo no hay selector de color.

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
      return (
        <ColorTema
          label={t('insp.bgColor')}
          value={valor}
          onChange={onChange}
          permiteNinguno />);


    case 'color':
      return (
        <ColorTema
          label={t('insp.color')}
          value={valor ?? 'var(--psi-primary)'}
          onChange={onChange} />);

    case 'borderColor':
      return (
        <ColorTema
          label={t('insp.borderColor')}
          value={valor ?? 'var(--psi-outline)'}
          onChange={onChange} />);

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
/**
 * Una variable con nombre del widget.
 *
 * Componente aparte y no JSX suelto dentro del Inspector porque necesita
 * estado propio: el nombre se edita en un borrador y sólo se guarda al
 * salir del campo. Guardando en cada tecla, escribir «fallo» crearía por el
 * camino los enlaces «f», «fa», «fal»… y el primero que chocara con otro
 * nombre cortaría la escritura a media palabra.
 */
function FilaEnlace({
  nombre,
  fijo,
  etiqueta,
  ayuda,
  variableId,
  grupos,
  variable,
  onVariable,
  onRenombrar,
  onQuitar





}: {nombre: string;fijo: boolean;etiqueta: string;ayuda?: string;variableId: string;grupos: {label: string;options: {label: string;value: string;}[];}[];variable?: PlcVariable;onVariable: (v: string) => void;onRenombrar: (nuevo: string) => string;onQuitar: () => void;}) {
  const [borrador, setBorrador] = useState(nombre);
  const [error, setError] = useState('');

  // Al saltar de un widget a otro, la fila se reutiliza con otro nombre.
  useEffect(() => {
    setBorrador(nombre);
    setError('');
  }, [nombre]);

  const cerrarNombre = () => {
    if (borrador === nombre) return;
    const fallo = onRenombrar(borrador);
    setError(fallo);
    if (fallo) setBorrador(nombre);
  };

  return (
    <div className="rounded-lg border border-slate-200 px-2.5 py-2 dark:border-navy-slate">
      <div className="mb-1.5 flex items-center gap-2">
        {fijo ?
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-navy dark:text-slate-100">
            {etiqueta}
          </span> :

        <input
          value={borrador}
          onChange={(e) => setBorrador(e.target.value)}
          onBlur={cerrarNombre}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setBorrador(nombre);
              setError('');
            }
          }}
          spellCheck={false}
          className={"min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-semibold text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100"} />

        }

        {/* El valor de AHORA MISMO. Es la forma de comprobar que el enlace
            apunta a donde se quería sin salir del Diseñador. */}
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-500 dark:bg-navy-slate/50 dark:text-slate-400">
          {variable ? formatValue(variable) : '—'}
        </span>

        {!fijo &&
        <button
          onClick={onQuitar}
          title="Quitar esta variable"
          className="shrink-0 rounded p-0.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10">

            <Trash2Icon className="h-3.5 w-3.5" />
          </button>
        }
      </div>

      <select
        value={variableId}
        onChange={(e) => onVariable(e.target.value)}
        className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100">

        {grupos.map((g) =>
        g.options.length === 0 ?
        null :
        g.label ?
        <optgroup key={g.label} label={g.label}>
              {g.options.map((o) =>
          <option key={o.value} value={o.value}>
                  {o.label}
                </option>
          )}
            </optgroup> :

        g.options.map((o) =>
        <option key={o.value} value={o.value}>
              {o.label}
            </option>
        )
        )}
      </select>

      {(error || ayuda) &&
      <span
        className={`mt-1 block text-[10px] leading-relaxed ${
        error ? 'text-red-500' : 'text-slate-400'}`
        }>

          {error || ayuda}
        </span>
      }
    </div>);

}

/** Qué se puede cambiar, y con qué palabras se dice. */
const TIPOS_DINAMICA: {valor: TipoDinamica;label: string;}[] = [
{ valor: 'color', label: 'Color' },
{ valor: 'fondo', label: 'Fondo' },
{ valor: 'borde', label: 'Borde' },
{ valor: 'visibilidad', label: 'Visibilidad' },
{ valor: 'parpadeo', label: 'Parpadeo' }];


const OPERADORES: {valor: OperadorDinamica;label: string;}[] = [
{ valor: 'verdadero', label: 'es verdadero' },
{ valor: 'falso', label: 'es falso' },
{ valor: '==', label: '=' },
{ valor: '!=', label: '≠' },
{ valor: '>', label: '>' },
{ valor: '>=', label: '≥' },
{ valor: '<', label: '<' },
{ valor: '<=', label: '≤' },
{ valor: 'entre', label: 'entre' }];


/**
 * Una regla: CUANDO <condición>, ENTONCES <efecto>.
 *
 * Componente propio, como las filas de variables: así sus campos no obligan
 * a repintar el Inspector entero mientras se escribe un número.
 */
function TarjetaDinamica({
  d,
  fuentes,
  onCambio,
  onQuitar




}: {d: Dinamica;fuentes: {valor: string;label: string;}[];onCambio: (parche: Partial<Dinamica>) => void;onQuitar: () => void;}) {
  const esColor = d.tipo === 'color' || d.tipo === 'fondo' || d.tipo === 'borde';

  return (
    <div className="space-y-2 rounded-lg border border-slate-200 px-2.5 py-2 dark:border-navy-slate">
      <div className="flex items-center gap-2">
        <select
          value={d.tipo}
          onChange={(e) => {
            const tipo = e.target.value as TipoDinamica;
            // Al pasar a un tipo de color hay que estrenar uno: sin color, la
            // regla se cumpliría y no se vería nada, que parece un fallo.
            const nuevo = dinamicaNueva(tipo);
            onCambio({ tipo, color: d.color ?? nuevo.color });
          }}
          className="w-full cursor-pointer rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100">

          {TIPOS_DINAMICA.map((x) =>
          <option key={x.valor} value={x.valor}>
              {x.label}
            </option>
          )}
        </select>
        <button
          onClick={onQuitar}
          title="Quitar esta regla"
          className="shrink-0 rounded p-0.5 text-slate-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10">

          <Trash2Icon className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="space-y-1.5 rounded-md bg-slate-50 px-2 py-1.5 dark:bg-navy-slate/30">
        <span className="block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Cuando
        </span>
        <select
          value={d.fuente}
          onChange={(e) => onCambio({ fuente: e.target.value })}
          className="w-full cursor-pointer rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100">

          {fuentes.map((f) =>
          <option key={f.valor} value={f.valor}>
              {f.label}
            </option>
          )}
        </select>
        <div className="flex items-center gap-1.5">
          <select
            value={d.operador}
            onChange={(e) => onCambio({ operador: e.target.value as OperadorDinamica })}
            className="w-full cursor-pointer rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100">

            {OPERADORES.map((x) =>
            <option key={x.valor} value={x.valor}>
                {x.label}
              </option>
            )}
          </select>
          {PIDE_VALOR(d.operador) &&
          <input
            value={String(d.valor ?? '')}
            onChange={(e) => onCambio({ valor: e.target.value })}
            placeholder="0"
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100" />

          }
          {d.operador === 'entre' &&
          <>
              <span className="shrink-0 text-[10px] text-slate-400">y</span>
              <input
              value={String(d.valor2 ?? '')}
              onChange={(e) => onCambio({ valor2: Number(e.target.value) })}
              placeholder="100"
              className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100" />

            </>
          }
        </div>
      </div>

      {esColor &&
      <ColorTema
        label="Entonces, este color"
        value={d.color ?? 'var(--psi-error)'}
        onChange={(v) => onCambio({ color: v })} />

      }

      {d.tipo === 'visibilidad' &&
      <label className="block">
          <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            Entonces
          </span>
          <select
          value={d.efecto ?? 'mostrar'}
          onChange={(e) => onCambio({ efecto: e.target.value as 'mostrar' | 'ocultar' })}
          className="w-full cursor-pointer rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-navy outline-none transition focus:border-siemens dark:border-navy-slate dark:bg-navy dark:text-slate-100">

            <option value="mostrar">Se ve</option>
            <option value="ocultar">No se ve</option>
          </select>
        </label>
      }

      {d.tipo === 'parpadeo' &&
      <p className="text-[10px] leading-relaxed text-slate-400">
          Parpadea en la Vista Previa. En el lienzo no, o no se podría trabajar.
        </p>
      }
    </div>);

}

export function PropertyInspector({
  widget,
  selectedVariables,
  onChange,
  onStyleChange,
  onDelete
}: Props) {
  const { t, widgetLabel, pantallas, projectId } = useAppStore();

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

  // Su sección ya no está en el menú: se borró con el widget dentro. Hay que
  // decirlo, porque desde la navegación ya no hay manera de llegar a él.
  const huerfana =
    !!(widget.vista ?? '').trim() &&
    !seccionesNav.some((s) => s.id === widget.vista);

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

  /* Si esta pantalla es un TIPO de faceplate, sus parámetros se pueden
     enlazar como si fueran variables. Es lo que hace reutilizable al tipo:
     el widget guarda `param:marcha` y cada instancia decide qué tag va ahí.

     Van los PRIMEROS: dentro de un tipo, enlazar a un tag real es la
     excepción —deja ese widget clavado al mismo tag en las cuarenta
     instancias— y lo normal es enlazar a un parámetro. */
  const fichaPantalla = pantallas.find((p) => p.project_id === projectId);
  const paramsFaceplate = fichaPantalla?.es_faceplate
    ? fichaPantalla.parametros ?? []
    : [];

  /**
   * Las opciones del desplegable de variables, para un tipo dado.
   *
   * Sale de aquí y no del cuerpo del Inspector porque ahora hay más de un
   * desplegable: la variable principal y cada variable con nombre, y cada una
   * admite tipos distintos.
   */
  const gruposDe = (admite: DataType[] | undefined) => {
    const reparto = repartirPorCompatibilidad(selectedVariables, admite);
    // Los parámetros del faceplate, filtrados por tipo cuando el enlace dice
    // cuál quiere: ofrecer un parámetro booleano para una velocidad es
    // ofrecer un enlace que no va a funcionar.
    const params = paramsFaceplate.filter(
      (p) => !admite || admite.length === 0 || admite.includes(p.tipo as DataType)
    );
    return [
    { label: '', options: [{ label: t('insp.none'), value: '' }] },
    ...(params.length > 0 ?
    [{
      label: 'Parámetros del faceplate',
      options: params.map((p) => ({
        label: `${p.nombre}  (${p.tipo})`,
        value: `param:${p.id}`
      }))
    }] :
    []),
    { label: t('insp.varsCompatible'), options: reparto.compatibles.map(opcion) },
    { label: t('insp.varsOther'), options: reparto.otras.map(opcion) }];

  };

  // ── Variables CON NOMBRE ──────────────────────────────────────
  //
  // Dos orígenes. Las DECLARADAS las pide el tipo de widget (una bomba sabe
  // que quiere un `fallo`), y su nombre no se toca. Las LIBRES las añade
  // quien diseña, y son las que harán falta para las dinámicas: un
  // rectángulo que cambia de color no declara nada, pero necesita mirar un
  // tag.
  // Las declara el tipo de widget: en su definición si es de los nuestros,
  // y en el `widget.json` si vino importado en un ZIP. Para quien diseña la
  // pantalla son lo mismo, así que se ofrecen igual.
  const zipDef = zipByKind(widget.kind);
  const declaradas: DeclaracionEnlace[] =
  custom?.enlaces ?? zipDef?.meta.variables ?? [];
  const enlaces = leerEnlaces(widget);
  const libres = Object.keys(enlaces).filter(
    (k) => !declaradas.some((d) => d.id === k)
  );
  const nombresUsados = [...declaradas.map((d) => d.id), ...libres];
  const variablePorId = (id: string) =>
  id && !id.startsWith('param:') ?
  selectedVariables.find((v) => v.id === id) :
  undefined;

  // ── Dinámicas ─────────────────────────────────────────────────
  const dinamicas = leerDinamicas(widget);
  const fuentesDinamica = [
  { valor: '', label: 'Variable principal' },
  ...nombresUsados.map((k) => ({ valor: k, label: k }))];

  const cambiarDinamica = (id: string, parche: Partial<Dinamica>) =>
  onChange({
    dinamicas: dinamicas.map((x) => x.id === id ? { ...x, ...parche } : x)
  });

  const varGroups = [
  { label: '', options: [{ label: t('insp.none'), value: '' }] },
  ...(paramsFaceplate.length > 0
    ? [{
        label: 'Parámetros del faceplate',
        options: paramsFaceplate.map((p) => ({
          label: `${p.nombre}  (${p.tipo})`,
          value: `param:${p.id}`,
        })),
      }]
    : []),
  { label: t('insp.varsCompatible'), options: compatibles.map(opcion) },
  { label: t('insp.varsOther'), options: otras.map(opcion) }];

  // Variable enlazada ahora mismo, para avisar si no calza. Puede venir de un
  // diseño guardado antes de que existiera esta validación.
  const variableActual = selectedVariables.find((v) => v.id === widget.variableId);
  // Un `param:` no es una variable: no hay tipo que comparar todavía —lo
  // pondrá cada instancia— así que avisar de incompatibilidad ahí sería
  // avisar de algo que aún no se ha decidido.
  const aviso = String(widget.variableId ?? '').startsWith('param:')
    ? ''
    : avisoIncompatible(acepta, variableActual);

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
      {/* La condición incluye `huerfana`: un widget cuya sección ya no
          existe tiene que poder arreglarse desde aquí, y eso pasa
          justamente en pantallas donde puede no quedar ningún menú. Sin
          ese caso, el panel desaparecía y el widget se quedaba atrapado
          con un id que no lleva a ninguna parte. */}
      {(seccionesNav.length > 0 || huerfana) && !esNavegacion &&
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
          {huerfana &&
          <BotonSeccion
            activo
            onClick={() => onChange({ vista: VISTA_TODAS })}
            titulo="Esta sección ya no existe en el menú. Pulsa para devolverlo a «En todas».">
            {widget.vista} · huérfana
          </BotonSeccion>
          }
        </div>
        <p className="text-[11px] leading-relaxed text-slate-400">
          {huerfana ?
          'La sección «' + widget.vista + '» ya no está en el menú, así que ' +
          'este widget no se puede abrir desde la navegación. Elige otra o ' +
          'ponlo en «En todas».' :
          widget.vista ?
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

      {/* ── Variables con nombre ─────────────────────────────────
          Aparece SIEMPRE, también en los widgets decorativos: un rectángulo
          no lee ninguna variable para pintarse, pero es justo al que se le
          querrá poner una para que cambie de color. */}
      <Section title="Variables con nombre">
        {declaradas.map((d) =>
        <FilaEnlace
          key={d.id}
          nombre={d.id}
          fijo
          etiqueta={d.label}
          ayuda={d.ayuda}
          variableId={enlaces[d.id] ?? ''}
          grupos={gruposDe(d.accepts)}
          variable={variablePorId(enlaces[d.id] ?? '')}
          onVariable={(v) =>
          onChange({
            enlaces: v ? conEnlace(widget, d.id, v) : sinEnlace(widget, d.id)
          })
          }
          onRenombrar={() => ''}
          onQuitar={() => {}} />

        )}

        {libres.map((k) =>
        <FilaEnlace
          key={k}
          nombre={k}
          fijo={false}
          etiqueta={k}
          variableId={enlaces[k] ?? ''}
          grupos={gruposDe(undefined)}
          variable={variablePorId(enlaces[k] ?? '')}
          onVariable={(v) => onChange({ enlaces: conEnlace(widget, k, v) })}
          onRenombrar={(nuevo) => {
            const fallo = validarNombreEnlace(
              nuevo,
              nombresUsados.filter((x) => x !== k)
            );
            if (!fallo) onChange({ enlaces: renombrarEnlace(widget, k, nuevo) });
            return fallo;
          }}
          onQuitar={() => onChange({ enlaces: sinEnlace(widget, k) })} />

        )}

        <button
          onClick={() =>
          onChange({ enlaces: conEnlace(widget, nombreLibre(enlaces), '') })
          }
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-medium text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400">

          <PlusIcon className="h-3.5 w-3.5" />
          Añadir variable
        </button>

        <p className="text-[10px] leading-relaxed text-slate-400">
          Variables ADEMÁS de la principal, cada una con su nombre. Un equipo
          no se representa con un solo valor: una bomba es marcha, fallo,
          manual y velocidad a la vez.
        </p>
      </Section>

      {/* ── Dinámicas ────────────────────────────────────────────
          Lo que hace que la pantalla esté viva. Va DESPUÉS de las variables
          porque una regla casi siempre mira una de ellas: primero se declara
          qué se lee, y luego qué se hace con ello. */}
      <Section title="Dinámicas">
        {dinamicas.map((d) =>
        <TarjetaDinamica
          key={d.id}
          d={d}
          fuentes={fuentesDinamica}
          onCambio={(parche) => cambiarDinamica(d.id, parche)}
          onQuitar={() =>
          onChange({ dinamicas: dinamicas.filter((x) => x.id !== d.id) })
          } />

        )}

        <button
          onClick={() => onChange({ dinamicas: [...dinamicas, dinamicaNueva()] })}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-medium text-slate-500 transition hover:border-siemens hover:text-siemens dark:border-navy-slate dark:text-slate-400">

          <PlusIcon className="h-3.5 w-3.5" />
          Añadir regla
        </button>

        <p className="text-[10px] leading-relaxed text-slate-400">
          Se aplican de arriba abajo y manda la ÚLTIMA que se cumpla: pon
          arriba lo general y debajo las excepciones. Si su variable no está
          leyendo, la regla no se aplica — nunca se inventa un valor.
        </p>
      </Section>

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
          paramsPantalla={paramsFaceplate}
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