// =========================================================================
// SelectorBaseRecetas.tsx
// "Guardar en": en qué base de datos viven las cuatro tablas de recetas.
//
// El control vive en `ui/SelectorBaseDatos.tsx` desde que Alarmas necesitó
// exactamente el mismo: dos copias del mismo desplegable se van separando
// solas con el tiempo, y terminas con dos pantallas que se ven casi igual
// pero no del todo. Acá quedan únicamente los TEXTOS de recetas.
//
// LO QUE NO ES
//
//   No es la base con la que se inició sesión (esa la elige el login), ni la
//   ruta `Path` de la receta (esa es la carpeta del panel HMI, como en TIA).
//   Es dónde se guardan ESTAS tablas, y vale para toda la pantalla: una fila
//   no puede apuntar a una base distinta de aquella en la que está.
// =========================================================================
import { SelectorBaseDatos } from '../ui/SelectorBaseDatos';
import type { BaseDatos } from '../../services/authApi';

export function SelectorBaseRecetas({
  valor,
  bases,
  deshabilitado,
  onCambiar,
}: {
  valor: string;
  bases: BaseDatos[];
  deshabilitado: boolean;
  onCambiar: (v: string) => void;
}) {
  return (
    <SelectorBaseDatos
      valor={valor}
      bases={bases}
      deshabilitado={deshabilitado}
      onCambiar={onCambiar}
      titulo="Guardar las recetas en"
      ayuda="Base de datos donde viven las cuatro tablas de recetas"
      nota={
        <>
          Cambia dónde se leen y se guardan recetas, elementos, registros y
          valores. No es la columna <span className="font-mono">Path</span>,
          que es la carpeta del panel HMI.
        </>
      }
    />
  );
}
