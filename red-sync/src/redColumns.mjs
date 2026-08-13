// Mismo mapeo que RED_COLUMNS en admin-panel.html — mantener ambos en
// sincro si Dichter Neira vuelve a renombrar columnas del export.
//
// NARTD verificado contra un archivo real descargado el 2026-08-13.
// VSR y ABI todavía NO se verificaron contra un archivo real de esta
// sesión — son los mismos nombres que ya usaba admin-panel.html/el
// script Python original, pueden estar tan desactualizados como NARTD
// lo estaba. Confirmar con un archivo real antes de confiar en ellos.
export const RED_COLUMNS = {
  VSR: [
    ["Red %", "red_pct"],
    ["NSS % (50%) ", "nss_pct"],
    ["Catalogos % (50%) ", "catalogos_pct"],
  ],
  ABI: [
    ["Red %", "red_pct"],
    ["NSS % (25%) ", "nss_pct"],
    ["SOVI % (25%)", "sovi_pct"],
    ["Exhib Adicionales % (25%)", "exhib_adicionales_pct"],
    ["Catalogos % (25%)", "catalogos_pct"],
  ],
  NARTD: [
    ["Red %", "red_pct"],
    ["NSS% (20%)", "nss_pct"],
    ["SOVI% (35%)", "sovi_pct"],
    ["NSF% (5%)", "nsf_pct"],
    ["Exhibición (12%)", "exhib_pactadas_pct"],
    ["Estrat ICE% (20%)", "estrat_ice_pct"],
    ["Catalogos (5%)", "catalogos_pct"],
    ["Com Pop (3%)", "com_pop_pct"],
    ["Bonus Total", "bonus_total"],
    ["Bonus ICE", "ice_bonus"],
    ["Bonus VTM", "bonus_vtm"],
    ["Bonus Tienda", "bonus_tienda"],
  ],
};

export const RED_TABLE = { VSR: "red_vsr", ABI: "red_abi", NARTD: "red_nartd" };
