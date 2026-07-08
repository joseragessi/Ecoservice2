const { createClient } = require('@supabase/supabase-js');

// Cliente para la base de COMPRAS (separada de la del bot).
// Usa las variables SUPABASE_COMPRAS_URL y SUPABASE_COMPRAS_KEY de Railway.
const supabaseCompras = createClient(
  process.env.SUPABASE_COMPRAS_URL,
  process.env.SUPABASE_COMPRAS_KEY
);

module.exports = supabaseCompras;
