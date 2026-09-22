// =========================================================================
// inspectores/accion.tsx
// Qué manda un botón —o un interruptor— cuando el operario lo pulsa.
//
// LAS TRES ACCIONES, Y POR QUÉ ESTAS
// `escribir`, `alternar` e `incrementar` cubren de una vez casi todo lo que
// TIA Portal reparte en funciones distintas —SetValue, SetBit, ResetBit,
// InvertBit, IncreaseTag, DecreaseTag— y lo que WebIQ llama `write-item`,
// `item-toggle` e `increment-item-value`.
//
// SÓLO SE OFRECEN LOS TAGS HABILITADOS
// El servidor sólo escribe tags dados de alta en `/escritura/permitidos`, con
// sus límites. Dejar configurar un botón contra un tag que va a ser rechazado
// es un fallo que no se descubre en el Diseñador sino en planta, pulsando, y
// además con un mensaje que no dice qué hacer.
//
// La barrera de verdad sigue estando en el servidor: esto es comodidad, no
// seguridad. Quien llame al endpoint a mano se topa con lo mismo.
// =========================================================================
import { useEffect, useState } from 'react';
import type { InspectorCtx } from '../custom/types';
import {
  leerAccion,
  permiteEscritura,
  ACCIONES_DE_PLC,
  type AccionWidget,
  type TipoAccion,
} from '../acciones';
import { useSecciones, GRUPO_POR_DEFECTO } from '../custom/navegacion/store';
import { leerTemas } from '../../../services/temaApi';
import type { Tema } from '../../../models/tema';
import {
  permitidosCacheados,
  EVENTO_PERMITIDOS,
  unirId,
  type TagPermitido } from
'../../../services/escrituraApi';
import { useTipos } from '../custom/faceplate/Faceplate';
import { useAppStore } from '../../../context/AppStore';
import { PREFIJO_PARAM } from '../../../utils/designStorage';

const TIPOS: { valor: TipoAccion; label: string; ayuda: string }[] = [
  { valor: 'ninguna', label: 'Ninguna', ayuda: 'El widget sólo se mira; no manda nada.' },
  {
    valor: 'escribir',
    label: 'Escribir un valor',
    ayuda: 'Manda siempre el mismo valor. Es el SetValue / SetBit de TIA.',
  },
  {
    valor: 'alternar',
    label: 'Alternar (encender / apagar)',
    ayuda:
      'Lee el valor actual y manda el contrario. Necesita que el tag se esté ' +
      'leyendo: sin lectura no se alterna, se impondría un valor a ciegas.',
  },
  {
    valor: 'incrementar',
    label: 'Sumar o restar',
    ayuda: 'Manda el valor actual más el paso. Con paso negativo, resta.',
  },
  // ── Las que no tocan el PLC ──────────────────────────────────
  {
    valor: 'ir-a-seccion',
    label: 'Ir a una sección',
    ayuda:
      'Abre una sección del Menú Lateral. Usa el mismo mando que el menú y ' +
      'que las pestañas de la barra, así que los tres se sincronizan solos.',
  },
  {
    valor: 'reconocer-alarmas',
    label: 'Reconocer todas las alarmas',
    ayuda: 'Firma de golpe todas las pendientes. Conviene pedir confirmación.',
  },
  {
    valor: 'modo-color',
    label: 'Cambiar modo claro / oscuro',
    ayuda: 'Cambia el modo en ESTE equipo. No afecta a los demás paneles.',
  },
  {
    valor: 'tema',
    label: 'Cambiar el tema activo',
    ayuda:
      'Cambia el tema de TODA la instalación, no sólo de este panel: lo ven ' +
      'todos los equipos conectados, al momento.',
  },
  {
    valor: 'aviso',
    label: 'Mostrar un aviso',
    ayuda: 'Enseña un mensaje y no hace nada más.',
  },
  {
    valor: 'salir',
    label: 'Cerrar sesión',
    ayuda: 'Cierra la sesión y vuelve a la pantalla de acceso.',
  },
  // ── Ventanas de faceplate ───────────────────────────────────
  {
    valor: 'abrir-faceplate',
    label: 'Abrir un faceplate',
    ayuda:
      'Abre un tipo de faceplate en una ventana flotante, con los tags de ' +
      'ESTE equipo. Es el popup de TIA Portal: pulsas el motor del sinóptico ' +
      'y sale su faceplate encima, sin salir de la pantalla.',
  },
  {
    valor: 'cerrar-faceplate',
    label: 'Cerrar el faceplate',
    ayuda:
      'Cierra la ventana de encima. Dentro de un faceplate, eso es ella ' +
      'misma, así que sirve para su propio botón de «Cerrar».',
  },
];

/** Las que no tiene sentido confirmar. Ver el comentario de más abajo. */
const SIN_CONFIRMACION: TipoAccion[] = [
  'ninguna',
  'aviso',
  'abrir-faceplate',
  'cerrar-faceplate',
];

export function InspectorAccion({
  config,
  setConfig,
  paramsPantalla = [],
}: InspectorCtx) {
  const accion = leerAccion(config);
  const [permitidos, setPermitidos] = useState<TagPermitido[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const secciones = useSecciones(accion.grupo || GRUPO_POR_DEFECTO);
  const [temas, setTemas] = useState<Tema[]>([]);
  const { variables } = useAppStore();
  // Los tipos de faceplate, sólo si la acción los necesita (ver `useTipos`).
  const { tipos, cargando: cargandoTipos } = useTipos(
    accion.tipo === 'abrir-faceplate'
  );
  const tipoElegido = tipos.find((x) => x.project_id === accion.faceplate);
  const parametros = tipoElegido?.parametros ?? [];

  // Los temas sólo hacen falta para una de las acciones, así que se piden
  // sólo cuando se elige: en un Inspector que se abre a cada clic, una
  // petición que casi nunca se usa es ruido en la red del panel.
  useEffect(() => {
    if (accion.tipo !== 'tema') return;
    let vivo = true;
    leerTemas()
      .then((d) => {
        if (vivo) setTemas(d.temas);
      })
      .catch(() => {
        /* el aviso de abajo lo dice */
      });
    return () => {
      vivo = false;
    };
  }, [accion.tipo]);

  // Sube cuando un administrador toca la lista blanca. Solo dispara el efecto
  // de abajo: el dato sale de la cache compartida.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const alCambiar = () => setRevision((n) => n + 1);
    window.addEventListener(EVENTO_PERMITIDOS, alCambiar);
    return () => window.removeEventListener(EVENTO_PERMITIDOS, alCambiar);
  }, []);

  // `permitidosCacheados` y no `listarPermitidos`: la lista la comparten este
  // panel, el Valor con Unidad y la pantalla de Configuracion. Con una
  // peticion por panel, seleccionar un boton disparaba un GET nuevo — y, peor,
  // habilitar un tag dejaba este desplegable con la lista vieja hasta recargar.
  useEffect(() => {
    let vivo = true;
    setCargando(true);
    permitidosCacheados()
      .then((l) => {
        if (vivo) {
          setPermitidos(l);
          setError('');
        }
      })
      .catch((e: any) => {
        if (vivo) setError(e?.message ?? 'No se pudo leer la lista de escritura.');
      })
      .finally(() => {
        if (vivo) setCargando(false);
      });
    return () => {
      vivo = false;
    };
  }, [revision]);

  const set = (parche: Partial<AccionWidget>) =>
    setConfig({ ...config, accion: { ...accion, ...parche } });

  const ayuda = TIPOS.find((x) => x.valor === accion.tipo)?.ayuda ?? '';
  const elegido = permitidos.find((p) => unirId(p.plc_id, p.tag) === accion.tag);
  // Un tag que se configuró y luego se quitó de la lista blanca. No se borra
  // en silencio: se enseña marcado, porque el botón va a fallar al pulsarlo y
  // el diseñador tiene que poder verlo aquí y no en planta.
  const huerfano = !!accion.tag && !elegido && !cargando;

  // El modo va al lado de la acción pero NO dentro: no es una acción, es en
  // qué estado está el widget. Ver `permiteEscritura` en `acciones.ts`.
  const escritura = permiteEscritura(config);

  return (
    <>
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Modo
        </span>
        <select
          value={escritura ? 'escritura' : 'lectura'}
          onChange={(e) =>
            // Se escribe `escritura` y se BORRA el `modo` viejo de «Valor con
            // Unidad»: dejarlo sería guardar dos veces lo mismo, y el día que
            // alguien edite el JSON a mano tendría dos campos que se
            // contradicen sin saber cuál manda.
            setConfig({
              ...config,
              escritura: e.target.value === 'escritura',
              modo: undefined,
            })
          }
          className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          <option value="lectura">Sólo lectura</option>
          <option value="escritura">Lectura y escritura</option>
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {escritura
            ? 'El widget puede mandar valores al PLC. El servidor sigue exigiendo que el tag esté en la lista blanca.'
            : 'El widget sólo muestra. Si intenta escribir, se le rechaza aquí mismo, sin llegar al PLC.'}
        </span>
      </label>

      {/* LA UNIDAD, COMPARTIDA.
          Vive en `config.unidad`, que es el MISMO campo que «Valor con
          Unidad» usa desde siempre: no se inventa uno nuevo, se comparte el
          que ya había. Un widget importado la recibe en `WIDGET.unidad` y la
          dibuja donde quiera; si no la usa, no pasa nada.

          No se saca del PLC a propósito: el OPC UA no siempre la trae, y
          cuando la trae viene como la escribió el programador («KMH»,
          «Km/h», vacía). Escribiéndola aquí, la pantalla dice lo que tiene
          que decir. */}
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Unidad
        </span>
        <input
          value={typeof config?.unidad === 'string' ? config.unidad : ''}
          onChange={(e) => setConfig({ ...config, unidad: e.target.value })}
          placeholder="km/h, bar, °C, rpm…"
          className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        />
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          Se escribe tal cual, sin tocar el PLC. Déjala vacía y sólo se ve el
          número. El widget decide si la dibuja.
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
          Al pulsar
        </span>
        <select
          value={accion.tipo}
          onChange={(e) => set({ tipo: e.target.value as TipoAccion })}
          className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
        >
          {TIPOS.map((x) => (
            <option key={x.valor} value={x.valor}>
              {x.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
          {ayuda}
        </span>
      </label>

      {/* Los campos de cada acción. La sección, el tema o el mensaje no
          tienen nada que ver con un tag del PLC, así que sólo se pide lo que
          esa acción usa: un formulario que enseña huecos que no hacen nada
          es un formulario que se rellena mal. */}
      {accion.tipo === 'ir-a-seccion' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
            Sección
          </span>
          <select
            value={accion.seccion ?? ''}
            onChange={(e) => set({ seccion: e.target.value })}
            className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          >
            <option value="">— Sin asignar —</option>
            {secciones.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label || x.id}
              </option>
            ))}
          </select>
          {secciones.length === 0 && (
            <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
              Esta pantalla no tiene Menú Lateral, así que no hay secciones a
              las que ir.
            </span>
          )}
        </label>
      )}

      {accion.tipo === 'modo-color' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
            Poner el modo
          </span>
          <select
            value={accion.modo ?? 'auto'}
            onChange={(e) => set({ modo: e.target.value as 'light' | 'dark' | 'auto' })}
            className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          >
            <option value="light">Claro</option>
            <option value="dark">Oscuro</option>
            <option value="auto">Según el sistema</option>
          </select>
        </label>
      )}

      {accion.tipo === 'tema' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
            Tema
          </span>
          <select
            value={accion.temaId ?? ''}
            onChange={(e) => set({ temaId: e.target.value })}
            className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          >
            <option value="">— Sin asignar —</option>
            {temas.map((x) => (
              <option key={x.id} value={x.id}>
                {x.nombre}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
            Cambia el tema de TODA la instalación, no sólo de este panel.
          </span>
        </label>
      )}

      {accion.tipo === 'aviso' && (
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
            Mensaje
          </span>
          <input
            type="text"
            value={accion.mensaje ?? ''}
            onChange={(e) => set({ mensaje: e.target.value })}
            placeholder="Revisar el nivel del tanque 3"
            className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
          />
        </label>
      )}

      {accion.tipo === 'abrir-faceplate' && (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Tipo de faceplate
            </span>
            <select
              value={accion.faceplate ?? ''}
              onChange={(e) => {
                const t = tipos.find((x) => x.project_id === e.target.value);
                // Los tags se vacían al cambiar de tipo: los del anterior no
                // significan nada en el nuevo. Y el título se rellena con el
                // nombre del tipo, que es lo que uno iba a escribir a mano.
                set({
                  faceplate: e.target.value,
                  params: {},
                  titulo: t?.nombre ?? '',
                });
              }}
              className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
            >
              <option value="">— Sin tipo —</option>
              {tipos.map((x) => (
                <option key={x.project_id} value={x.project_id}>
                  {x.nombre}
                </option>
              ))}
            </select>
            {!cargandoTipos && tipos.length === 0 && (
              <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">
                No hay ninguna pantalla marcada como tipo de faceplate. Se
                marca en el Diseñador, en «Tipo de faceplate».
              </span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Título de la ventana
            </span>
            <input
              type="text"
              value={accion.titulo ?? ''}
              onChange={(e) => set({ titulo: e.target.value })}
              placeholder="Motor P-101"
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
            />
          </label>

          {parametros.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                Tags de esta ventana
              </p>
              {parametros.map((p) => {
                // Sólo lo del tipo que el parámetro pide. Ofrecer una
                // booleana para una corriente es ofrecer un enlace que no
                // funciona y que sólo se descubre en planta.
                const compatibles = variables.filter((v) => v.type === p.tipo);
                const propios = paramsPantalla.filter((x) => x.tipo === p.tipo);
                return (
                  <label key={p.id} className="block">
                    <span className="mb-1 flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                        {p.nombre}
                      </span>
                      <code className="text-[10px] text-slate-400">{p.tipo}</code>
                    </span>
                    <select
                      value={accion.params?.[p.id] ?? ''}
                      onChange={(e) =>
                        set({
                          params: { ...accion.params, [p.id]: e.target.value },
                        })
                      }
                      className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
                    >
                      <option value="">— Sin asignar —</option>
                      {/* Los parámetros de ESTA pantalla van primero y sólo
                          aparecen si es un tipo de faceplate. Es lo que hace
                          que un botón «Histórico» dentro del faceplate de un
                          motor abra el histórico DE ESE motor, en las
                          cuarenta instancias, sin tocar ninguna. */}
                      {propios.length > 0 && (
                        <optgroup label="Parámetros de esta pantalla">
                          {propios.map((x) => (
                            <option key={x.id} value={`${PREFIJO_PARAM}${x.id}`}>
                              {x.nombre}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Variables">
                        {compatibles.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                Ancho
              </span>
              <input
                type="number"
                min={0}
                value={accion.ancho ?? 0}
                onChange={(e) => set({ ancho: Number(e.target.value) })}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                Alto
              </span>
              <input
                type="number"
                min={0}
                value={accion.alto ?? 0}
                onChange={(e) => set({ alto: Number(e.target.value) })}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
              />
            </label>
          </div>
          <span className="block text-[10px] leading-relaxed text-slate-400">
            0 = el tamaño con el que se dibujó el tipo.
          </span>

          <label className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Bloquear el resto
            </span>
            <input
              type="checkbox"
              checked={!!accion.modal}
              onChange={(e) => set({ modal: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
            />
          </label>
          <span className="block text-[10px] leading-relaxed text-slate-400">
            Con velo detrás: hasta cerrarla no se puede tocar nada más. Sin
            marcar, la ventana flota y el sinóptico se sigue operando.
          </span>
        </>
      )}

      {accion.tipo === 'cerrar-faceplate' && (
        <>
          <label className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Cerrar todas
            </span>
            <input
              type="checkbox"
              checked={!!accion.cerrarTodas}
              onChange={(e) => set({ cerrarTodas: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
            />
          </label>
          <span className="block text-[10px] leading-relaxed text-slate-400">
            Sin marcar cierra sólo la de encima, que es la que se está viendo.
          </span>
        </>
      )}

      {ACCIONES_DE_PLC.includes(accion.tipo) && (
        <>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
              Tag a escribir
            </span>
            <select
              value={accion.tag}
              onChange={(e) => set({ tag: e.target.value })}
              className="w-full cursor-pointer rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
            >
              <option value="">— Sin asignar —</option>
              {permitidos.map((p) => {
                const id = unirId(p.plc_id, p.tag);
                return (
                  <option key={id} value={id}>
                    {p.descripcion ? `${p.descripcion} · ${p.tag}` : p.tag}
                  </option>
                );
              })}
              {huerfano && (
                <option value={accion.tag}>
                  {accion.tag} (ya no está habilitado)
                </option>
              )}
            </select>
          </label>

          {accion.tipo === 'escribir' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                Valor
              </span>
              <input
                type="text"
                value={String(accion.valor ?? '')}
                onChange={(e) => {
                  // Se guarda con su tipo: `true`/`false` como booleano y los
                  // números como número. El servidor convierte al tipo real
                  // del tag, pero mandar la cadena "true" a un Bool es pedirle
                  // que adivine, y adivinar con una orden a una máquina no.
                  const v = e.target.value.trim();
                  const val =
                    v === 'true' ? true :
                    v === 'false' ? false :
                    v !== '' && Number.isFinite(Number(v)) ? Number(v) :
                    e.target.value;
                  set({ valor: val });
                }}
                placeholder="1, 0, true, false…"
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
              />
              <span className="mt-1 block text-[10px] text-slate-400">
                Se guarda como {typeof accion.valor}. El servidor lo convierte
                al tipo del tag y rechaza lo que no encaje.
              </span>
            </label>
          )}

          {accion.tipo === 'incrementar' && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-500 dark:text-slate-400">
                Paso
              </span>
              <input
                type="number"
                value={accion.paso ?? 1}
                step="any"
                onChange={(e) => set({ paso: Number(e.target.value) })}
                className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
              />
              <span className="mt-1 block text-[10px] text-slate-400">
                Negativo para restar.
              </span>
            </label>
          )}

        </>
      )}

      {/* La confirmación vale para las que MANDAN algo. Se quedan fuera el
          aviso —que ya ES un mensaje: preguntar si quieres ver un mensaje y
          luego enseñártelo son dos diálogos para nada— y abrir o cerrar una
          ventana, que no cambia nada del proceso y siempre se deshace
          volviendo a pulsar. */}
      {!SIN_CONFIRMACION.includes(accion.tipo) && (
        <>
          <label className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Pedir confirmación
            </span>
            <input
              type="checkbox"
              checked={!!accion.confirmar}
              onChange={(e) => set({ confirmar: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300 text-siemens focus:ring-2 focus:ring-siemens/40 dark:border-navy-slate dark:bg-navy"
            />
          </label>

          {accion.confirmar && (
            <input
              type="text"
              value={accion.mensaje ?? ''}
              onChange={(e) => set({ mensaje: e.target.value })}
              placeholder="¿Arrancar la bomba P-101?"
              className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-navy outline-none transition focus:border-siemens focus:ring-2 focus:ring-siemens/20 dark:border-navy-slate dark:bg-navy dark:text-slate-100"
            />
          )}

          {ACCIONES_DE_PLC.includes(accion.tipo) &&
          <div className="rounded-lg bg-slate-100 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 dark:bg-navy-slate/40 dark:text-slate-400">
            {error ? (
              <>No se pudo leer la lista de tags habilitados: {error}</>
            ) : cargando ? (
              'Leyendo los tags habilitados para escritura…'
            ) : permitidos.length === 0 ? (
              <>
                <b>No hay ningún tag habilitado para escritura.</b> El servidor
                sólo escribe los que estén en su lista blanca, así que este
                botón fallaría al pulsarlo. Habilítalos en{' '}
                <b>Configuración → Escritura</b> antes de seguir.
              </>
            ) : huerfano ? (
              <>
                <b>«{accion.tag}» ya no está habilitado</b> para escritura. El
                botón fallará al pulsarlo: elige otro tag o vuelve a
                habilitarlo.
              </>
            ) : accion.tipo === 'alternar' || accion.tipo === 'incrementar' ? (
              <>
                Estas dos LEEN antes de escribir. Si el PLC está caído no hay
                lectura, y el botón avisa en vez de mandar un valor inventado.
              </>
            ) : (
              <>
                La orden queda registrada en la auditoría con quién la dio y
                qué valor mandó.
              </>
            )}
          </div>
          }
        </>
      )}
    </>
  );
}
