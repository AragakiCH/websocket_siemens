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
  type AccionWidget,
  type TipoAccion,
} from '../acciones';
import { listarPermitidos, unirId, type TagPermitido } from '../../../services/escrituraApi';

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
];

export function InspectorAccion({ config, setConfig }: InspectorCtx) {
  const accion = leerAccion(config);
  const [permitidos, setPermitidos] = useState<TagPermitido[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    listarPermitidos()
      .then((l) => {
        if (vivo) setPermitidos(l);
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
  }, []);

  const set = (parche: Partial<AccionWidget>) =>
    setConfig({ ...config, accion: { ...accion, ...parche } });

  const ayuda = TIPOS.find((x) => x.valor === accion.tipo)?.ayuda ?? '';
  const elegido = permitidos.find((p) => unirId(p.plc_id, p.tag) === accion.tag);
  // Un tag que se configuró y luego se quitó de la lista blanca. No se borra
  // en silencio: se enseña marcado, porque el botón va a fallar al pulsarlo y
  // el diseñador tiene que poder verlo aquí y no en planta.
  const huerfano = !!accion.tag && !elegido && !cargando;

  return (
    <>
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

      {accion.tipo !== 'ninguna' && (
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
        </>
      )}
    </>
  );
}
