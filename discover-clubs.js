/**
 * Padel Club Discovery Module
 *
 * Discovers padel clubs from Playtomic, Matchi, Google Places, and future sources
 * for a given country, deduplicates them, filters noise, and returns a structured
 * JSON array.
 *
 * Usage:
 *   const { discoverClubs } = require('./discover-clubs');
 *   const clubs = await discoverClubs('GB', { includeMatchi: true });
 *
 *   // All non-stub sources:
 *   const clubs = await discoverClubs('GB', { allSources: true });
 *
 *   // Discover + enrich with Google Place IDs:
 *   const { discoverAndEnrich } = require('./discover-clubs');
 *   const enriched = await discoverAndEnrich('GB', { allSources: true });
 */

const { searchPlaces, lookupPlaceId } = require('./place-id-backfill');

// ─── Playtomic Tenant Blocklist ─────────────────────────────────────────────
// Known catch-all / junk tenant UUIDs that Playtomic returns for non-matching
// searches. These produce broken URLs and must never be matched to any venue.
const PLAYTOMIC_BLOCKLIST = {
  prefixes: ['0ce49dbf'],                                  // match any UUID starting with this
  exact: ['91474bfc-57ee-4c11-bda3-1bb091710f4d'],         // exact match
};

function isBlocklistedTenant(tenantId) {
  if (!tenantId) return false;
  const id = tenantId.toLowerCase();
  if (PLAYTOMIC_BLOCKLIST.exact.includes(id)) return true;
  if (PLAYTOMIC_BLOCKLIST.prefixes.some(p => id.startsWith(p))) return true;
  return false;
}

// ─── String Similarity (inline, no dependencies) ────────────────────────────

/**
 * Calculates similarity between two strings using bigram overlap (Dice coefficient).
 * Returns a value between 0 (completely different) and 1 (identical).
 */
function stringSimilarity(a, b) {
  if (!a || !b) return 0;

  // Normalise: lowercase, trim, remove punctuation
  const normalize = (s) => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const s1 = normalize(a);
  const s2 = normalize(b);

  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;

  // Build bigram maps
  const bigrams = (str) => {
    const map = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const pair = str.slice(i, i + 2);
      map.set(pair, (map.get(pair) || 0) + 1);
    }
    return map;
  };

  const map1 = bigrams(s1);
  const map2 = bigrams(s2);

  let intersection = 0;
  for (const [pair, count] of map1) {
    if (map2.has(pair)) {
      intersection += Math.min(count, map2.get(pair));
    }
  }

  return (2 * intersection) / (s1.length - 1 + s2.length - 1);
}

// ─── UK Postcode Extraction ─────────────────────────────────────────────────

/**
 * Extracts a UK postcode from an address string.
 * Pattern: 1-2 uppercase letters, 1 digit, optional digit/letter, space, digit, 2 uppercase letters.
 * Returns the postcode string or null if not found.
 */
function extractUKPostcode(address) {
  if (!address) return null;
  const match = address.match(/[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2}/i);
  return match ? match[0].toUpperCase() : null;
}

// ─── Noise Filter ────────────────────────────────────────────────────────────

/**
 * Known corporate / brand-level pages that are not individual venues.
 * When an entry matches one of these exactly (case-insensitive), it is noise.
 * Individual venue pages (e.g. "Game4Padel Manchester") will NOT match.
 */
const BRAND_CORPORATE_NAMES = [
  'game4padel',
  'we are padel',
  'padel nation',
];

// Brand abbreviation aliases — used during dedup to match shortened names
// e.g. "G4P Richmond" should match "Game4Padel Richmond"
const BRAND_ALIASES = {
  'g4p': 'game4padel',
  'game 4 padel': 'game4padel',
  'game4 padel': 'game4padel',
  'ipa': 'indoor padel australia',
  'wap': 'we are padel',
  'pnl': 'padel nation',
};

/**
 * Normalize brand abbreviations in a venue name for better dedup matching.
 * Replaces known abbreviations with their full brand names.
 */
function normalizeBrandName(name) {
  let normalized = name.toLowerCase().trim();
  for (const [abbrev, full] of Object.entries(BRAND_ALIASES)) {
    // Match abbreviation at start of name followed by space or end
    const pattern = new RegExp(`^${abbrev.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'i');
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, full);
      break; // Only one brand match per name
    }
  }
  return normalized;
}

/**
 * Returns true if a club name looks like noise (tennis-only, equipment, pickleball,
 * table tennis, coaches without venues, federations, event companies, etc.)
 *
 * Returns the string 'coming_soon' if the name suggests a venue under construction
 * (caller should treat as a warning, not a hard drop).
 *
 * Returns false if the entry looks like a genuine padel venue.
 */
function isNoise(name) {
  if (!name) return true;
  const lower = name.toLowerCase().trim();

  // ── Hard-drop noise patterns ──────────────────────────────────────────────
  // These cause an immediate drop regardless of whether "padel" appears in the name.

  // 1. Equipment manufacturers / retailers / shops
  const equipmentPatterns = [
    /\bequipment\b/,
    /\brack(?:et|quet)\s+shop\b/,
    /\bshop\b/,
    /\bstore\b/,
    /\bretail\b/,
    /\bmanufacturer\b/,
    /\bnuestro\b/,                    // "Padel Nuestro" — major retailer
    /\bvolt\s+padel\b/,              // "Volt Padel UK" — brand, not venue
    /\bpadel\s+tech\b/,              // equipment / tech brand
    /\bpadel\s+equipment\b/,
    /\bpadel\s+manufacturer\b/,
    /\bselling\s+rackets?\b/,
    /\bpro\s*direct\b/,              // pro:direct style retailers
  ];

  if (equipmentPatterns.some((p) => p.test(lower))) return true;

  // 2. Stringers / stringing services
  const stringerPatterns = [
    /\bstringer\b/,
    /\bstringing\b/,
    /\bsameday\s+stringing\b/,
    /\brack(?:et|quet)\s+stringer\b/,
  ];

  if (stringerPatterns.some((p) => p.test(lower))) return true;

  // 3. Federations (not venues)
  const federationPatterns = [
    /\bfederation\b/,
    /\bfederaci[oó]n\b/,
    /\bfédération\b/,
    /\bassociation\b/,
    /\b(?:lta|fep|fft|apusa)\b/,     // known federation abbreviations
  ];

  if (federationPatterns.some((p) => p.test(lower))) return true;

  // 4. Event companies / tournament organisers (without own courts)
  const eventHardDrop = [
    /\bevent\s+compan/,
    /\bevent\s+management\b/,
    /\btournament\s+organi[sz]/,
    /\bevent\s+organi[sz]/,
  ];

  if (eventHardDrop.some((p) => p.test(lower))) return true;

  // "Padel Events" / "Padel Tour" — only noise if no venue indicator in the name
  const eventSoftPatterns = [
    /\bpadel\s+events?\b/,
    /\bpadel\s+tours?\b/,
  ];
  const venueWords = /\bcourt|club|centre|center|arena|hub|facility|facilities|venue\b/;

  if (eventSoftPatterns.some((p) => p.test(lower)) && !venueWords.test(lower)) return true;

  // 5. Table tennis / ping pong venues
  const tableTennisPatterns = [
    /\btable\s+tennis\b/,
    /\bping\s*pong\b/,
  ];

  if (tableTennisPatterns.some((p) => p.test(lower))) return true;

  // 6. Duplicate brand / corporate pages (exact name match only)
  if (BRAND_CORPORATE_NAMES.includes(lower)) return true;

  // ── "Coming soon" check — returns special string, not boolean ─────────────
  // Caller should treat these as warnings (keep in pool but flag for review).
  const comingSoonPatterns = [
    /\bcoming\s+soon\b/,
    /\bunder\s+construction\b/,
    /\bopening\s+soon\b/,
    /\bpre[- ]?launch\b/,
    /\bnot\s+yet\s+open\b/,
  ];

  if (comingSoonPatterns.some((p) => p.test(lower))) return 'coming_soon';

  // ── Padel in the name = not noise ─────────────────────────────────────────
  // If the name explicitly mentions padel (or pádel), trust it as a venue.
  if (lower.includes('padel') || lower.includes('pádel')) return false;

  // ── Patterns that are noise ONLY when padel is NOT in the name ────────────

  // 7. Tennis-only clubs
  const tennisPatterns = [
    /\btennis\s+only\b/,
    /\btennis\s+club\b/,
    /\blawn\s+tennis\b/,
    /\btennis\s+centre\b/,
    /\btennis\s+center\b/,
  ];

  if (tennisPatterns.some((p) => p.test(lower))) return true;

  // 8. Pickleball-only
  const pickleballPatterns = [
    /\bpickleball\s+only\b/,
    /\bpickleball\s+club\b/,
    /\bpickleball\s+centre?\b/,
    /\bpickleball\s+center\b/,
  ];

  if (pickleballPatterns.some((p) => p.test(lower))) return true;

  // 9. Coaches / coaching businesses that are not venues
  //    Note: "Padel Academy" is NOT flagged — many real venues use "Academy"
  //    (e.g. Bali Padel Academy, NOX Future Academy). Only explicit coach indicators.
  const coachPatterns = [
    /\bcoach\s+\w+\s+padel\b/,       // "Coach John Padel"
    /\bpadel\s+coach(?:ing)?\b/,     // "Padel Coach" / "Padel Coaching"
    /\bpadel\s+instructor\b/,
    /\bpadel\s+lessons?\b/,
    /\bpadel\s+training\b/,          // "Padel Training"
    /\bpadel\s+tuition\b/,
  ];

  // Coach entries: only noise if name does NOT also contain court/club/centre indicators
  if (coachPatterns.some((p) => p.test(lower)) && !venueWords.test(lower)) return true;

  // 10. Generic "Sports Hub" / "Sports Centre" without padel mention
  const genericSportsPatterns = [
    /\bsports?\s+hub\b/,
    /\bsports?\s+centre\b/,
    /\bsports?\s+center\b/,
    /\badventure\s+hub\b/,
    /\bleisure\s+centre\b/,
    /\bleisure\s+center\b/,
    /\bactivity\s+centre\b/,
    /\bactivity\s+center\b/,
  ];

  if (genericSportsPatterns.some((p) => p.test(lower))) return true;

  return false;
}

// ─── Country Name Lookup ─────────────────────────────────────────────────────

/**
 * Simple mapping of common country codes to country names for Google queries.
 */
const COUNTRY_NAMES = {
  GB: 'United Kingdom', UK: 'United Kingdom',
  US: 'United States', CA: 'Canada', AU: 'Australia',
  DE: 'Germany', FR: 'France', ES: 'Spain', IT: 'Italy',
  NL: 'Netherlands', BE: 'Belgium', SE: 'Sweden', DK: 'Denmark',
  NO: 'Norway', FI: 'Finland', PT: 'Portugal', AT: 'Austria',
  CH: 'Switzerland', IE: 'Ireland', PL: 'Poland', CZ: 'Czech Republic',
  AE: 'UAE', SA: 'Saudi Arabia', QA: 'Qatar', BH: 'Bahrain',
  MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', CL: 'Chile',
  IN: 'India', JP: 'Japan', KR: 'South Korea', SG: 'Singapore',
  MY: 'Malaysia', TH: 'Thailand', ID: 'Indonesia', PH: 'Philippines',
  ZA: 'South Africa', EG: 'Egypt', KE: 'Kenya', NG: 'Nigeria',
};

function countryName(code) {
  return COUNTRY_NAMES[code.toUpperCase()] || code.toUpperCase();
}

// ─── Major Cities per Country (for city-level Google Places queries) ────────

const COUNTRY_CITIES = {
  AU: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Gold Coast', 'Canberra', 'Hobart', 'Darwin', 'Cairns', 'Townsville', 'Geelong', 'Newcastle', 'Wollongong', 'Sunshine Coast', 'Toowoomba', 'Ballarat', 'Bendigo', 'Launceston', 'Mackay', 'Rockhampton', 'Bunbury', 'Mandurah', 'Albury', 'Wodonga', 'Wagga Wagga', 'Mildura', 'Tamworth', 'Orange', 'Dubbo', 'Bathurst'],
  US: ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix', 'Miami', 'Dallas', 'San Francisco', 'Seattle', 'Denver', 'Atlanta', 'Boston', 'San Diego', 'Austin', 'Philadelphia', 'San Antonio', 'Jacksonville', 'Fort Worth', 'Columbus', 'Charlotte', 'Indianapolis', 'San Jose', 'Nashville', 'Memphis', 'Detroit', 'Portland', 'Las Vegas', 'Louisville', 'Milwaukee', 'Albuquerque', 'Tucson', 'Raleigh', 'Tampa', 'Orlando', 'Sacramento', 'Kansas City', 'Salt Lake City', 'Pittsburgh', 'Cincinnati', 'Honolulu', 'Boise', 'Richmond', 'Fort Lauderdale', 'Scottsdale', 'Naples FL', 'Palm Beach', 'Greenwich', 'Stamford', 'White Plains'],
  GB: ['London', 'Manchester', 'Birmingham', 'Leeds', 'Liverpool', 'Bristol', 'Edinburgh', 'Glasgow', 'Cardiff', 'Newcastle', 'Sheffield', 'Nottingham', 'Leicester', 'Coventry', 'Bradford', 'Belfast', 'Brighton', 'Plymouth', 'Stoke-on-Trent', 'Southampton', 'Reading', 'Derby', 'Wolverhampton', 'Sunderland', 'Norwich', 'Swansea', 'Aberdeen', 'Dundee', 'Bournemouth', 'Oxford', 'Cambridge', 'Exeter', 'York', 'Bath', 'Chester', 'Ipswich', 'Cheltenham', 'Guildford', 'Milton Keynes', 'Northampton', 'Warwick', 'Worcester', 'Canterbury', 'Inverness', 'Perth Scotland', 'Stirling'],
  ES: [
    // All 50 provincial capitals + major cities/towns
    'Madrid', 'Barcelona', 'Valencia', 'Seville', 'Zaragoza', 'Malaga', 'Murcia', 'Palma de Mallorca',
    'Las Palmas', 'Bilbao', 'Alicante', 'Cordoba', 'Valladolid', 'Vigo', 'Gijon', 'Vitoria-Gasteiz',
    'Granada', 'A Coruña', 'Elche', 'Oviedo', 'Santa Cruz de Tenerife', 'Pamplona', 'Almeria',
    'San Sebastian', 'Santander', 'Castellon', 'Burgos', 'Albacete', 'Salamanca', 'Logroño',
    'Huelva', 'Lleida', 'Tarragona', 'Badajoz', 'Leon', 'Cadiz', 'Jaen', 'Ourense', 'Girona',
    'Lugo', 'Caceres', 'Guadalajara', 'Toledo', 'Pontevedra', 'Ciudad Real', 'Palencia', 'Zamora',
    'Avila', 'Cuenca', 'Huesca', 'Segovia', 'Soria', 'Teruel',
    // Major non-capital cities
    'Marbella', 'Jerez de la Frontera', 'Cartagena', 'Talavera de la Reina', 'Torremolinos',
    'Benidorm', 'Fuengirola', 'Estepona', 'Getafe', 'Alcala de Henares', 'Leganes', 'Mostoles',
    'Alcorcon', 'Fuenlabrada', 'Torrejon de Ardoz', 'Parla', 'Alcobendas', 'San Sebastian de los Reyes',
    'Pozuelo de Alarcon', 'Las Rozas', 'Majadahonda', 'Boadilla del Monte', 'Tres Cantos',
    'Hospitalet de Llobregat', 'Badalona', 'Sabadell', 'Terrassa', 'Mataro', 'Santa Coloma',
    'Reus', 'Manresa', 'Vilafranca del Penedes', 'Sitges', 'Torrevieja', 'Orihuela',
    'Dos Hermanas', 'Algeciras', 'San Fernando', 'Chiclana', 'El Puerto de Santa Maria',
    'Roquetas de Mar', 'El Ejido', 'Lorca', 'Molina de Segura', 'Alcantarilla',
    'Santiago de Compostela', 'Ferrol', 'Ibiza', 'Menorca',
  ],
  SE: ['Stockholm', 'Gothenburg', 'Malmö', 'Uppsala', 'Linköping', 'Örebro', 'Helsingborg', 'Västerås', 'Norrköping', 'Jönköping', 'Umeå', 'Lund', 'Borås', 'Sundsvall', 'Gävle', 'Eskilstuna', 'Halmstad', 'Växjö', 'Karlstad', 'Kalmar', 'Kristianstad', 'Trollhättan', 'Östersund', 'Luleå', 'Falun', 'Visby', 'Nyköping', 'Skövde'],
  ID: ['Jakarta', 'Bali', 'Surabaya', 'Bandung', 'Medan', 'Yogyakarta', 'Makassar', 'Semarang', 'Palembang', 'Tangerang', 'Depok', 'Bekasi', 'Bogor', 'Malang', 'Denpasar', 'Balikpapan', 'Pekanbaru', 'Manado', 'Padang', 'Batam', 'Banjarmasin', 'Pontianak', 'Cirebon', 'Solo', 'Mataram', 'Samarinda', 'Jambi', 'Kupang', 'Ambon'],
  AE: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain', 'Al Ain'],
  TH: ['Bangkok', 'Phuket', 'Chiang Mai', 'Pattaya', 'Hua Hin', 'Koh Samui', 'Nonthaburi', 'Chon Buri', 'Nakhon Ratchasima', 'Udon Thani', 'Khon Kaen', 'Hat Yai', 'Pak Kret', 'Surat Thani', 'Krabi', 'Rayong'],
  PT: ['Lisbon', 'Porto', 'Faro', 'Cascais', 'Braga', 'Funchal', 'Coimbra', 'Setubal', 'Aveiro', 'Leiria', 'Viseu', 'Evora', 'Guimaraes', 'Vila Nova de Gaia', 'Portimao', 'Lagos', 'Albufeira', 'Tavira', 'Sintra', 'Estoril', 'Amadora', 'Almada', 'Oeiras', 'Matosinhos', 'Ponta Delgada'],
  IT: ['Milan', 'Rome', 'Turin', 'Florence', 'Naples', 'Bologna', 'Padua', 'Cagliari', 'Palermo', 'Genoa', 'Verona', 'Brescia', 'Bari', 'Catania', 'Venice', 'Modena', 'Parma', 'Bergamo', 'Monza', 'Perugia', 'Trieste', 'Reggio Emilia', 'Vicenza', 'Treviso', 'Pisa', 'Livorno', 'Pescara', 'Salerno', 'Lecce', 'Sassari', 'Como', 'Rimini', 'Ravenna', 'Ferrara', 'Siena', 'Ancona', 'Trento', 'Bolzano', 'Udine', 'Messina', 'Taranto', 'Foggia', 'Cosenza', 'Novara', 'Piacenza', 'Varese', 'La Spezia'],
  FR: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Bordeaux', 'Lille', 'Strasbourg', 'Montpellier', 'Nantes', 'Rennes', 'Reims', 'Toulon', 'Saint-Etienne', 'Le Havre', 'Grenoble', 'Dijon', 'Angers', 'Nimes', 'Clermont-Ferrand', 'Aix-en-Provence', 'Tours', 'Amiens', 'Limoges', 'Perpignan', 'Besancon', 'Metz', 'Orleans', 'Rouen', 'Pau', 'Caen', 'Bayonne', 'Biarritz', 'Avignon', 'Cannes', 'Antibes', 'La Rochelle', 'Poitiers', 'Brest', 'Ajaccio', 'Nancy', 'Mulhouse', 'Valence', 'Chambery', 'Annecy'],
  DE: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Düsseldorf', 'Stuttgart', 'Leipzig', 'Dortmund', 'Essen', 'Bremen', 'Dresden', 'Hanover', 'Nuremberg', 'Duisburg', 'Bochum', 'Wuppertal', 'Bielefeld', 'Bonn', 'Münster', 'Augsburg', 'Karlsruhe', 'Mannheim', 'Wiesbaden', 'Gelsenkirchen', 'Aachen', 'Freiburg', 'Kiel', 'Lübeck', 'Heidelberg', 'Mainz', 'Rostock', 'Potsdam', 'Saarbrücken', 'Regensburg', 'Wolfsburg', 'Braunschweig', 'Ingolstadt', 'Ulm', 'Erlangen', 'Trier', 'Bamberg', 'Konstanz', 'Passau'],
};

// ─── API Fetchers ────────────────────────────────────────────────────────────

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

/**
 * Fetch with a single retry on failure.
 */
async function fetchWithRetry(url, options = {}, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        console.log(`  [retry] Attempt ${attempt + 1} failed, retrying... (${err.message})`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw err;
      }
    }
  }
}

/**
 * Fetch clubs from the Playtomic API for a given country code.
 * Paginates through ALL pages until empty (API returns max 200 per page).
 */
async function fetchPlaytomic(countryCode) {
  console.log(`[playtomic] Fetching clubs for country: ${countryCode}...`);

  const baseUrl = `https://api.playtomic.io/v1/tenants?country_code=${countryCode.toUpperCase()}&sport_id=PADEL&size=500`;
  const allData = [];
  let page = 0;

  while (true) {
    const url = `${baseUrl}&page=${page}`;
    const data = await fetchWithRetry(url);

    if (!Array.isArray(data) || data.length === 0) break;

    allData.push(...data);
    console.log(`[playtomic] Page ${page}: ${data.length} results (running total: ${allData.length})`);

    if (data.length < 200) break; // Last page
    page++;
    await new Promise(r => setTimeout(r, 500)); // Rate limit between pages
  }

  const data = allData;

  if (data.length === 0) {
    console.log(`[playtomic] No results found.`);
    return [];
  }

  console.log(`[playtomic] Found ${data.length} total results across ${page + 1} pages.`);

  return data.filter(t => !isBlocklistedTenant(t.tenant_id)).map((t) => {
    // Extract court data from resources[] array (the real data source)
    const padelCourts = (t.resources || []).filter(r => r.sport_id === 'PADEL' && r.is_active !== false);
    const courtCount = padelCourts.length || t.properties?.number_of_courts || null;

    // Determine indoor/outdoor from per-court resource_type
    const courtTypes = padelCourts.map(r => r.properties?.resource_type).filter(Boolean);
    let indoorOutdoor = null;
    if (courtTypes.length > 0) {
      const hasIndoor = courtTypes.some(t => t === 'indoor');
      const hasOutdoor = courtTypes.some(t => t === 'outdoor' || t === 'roofed');
      if (hasIndoor && hasOutdoor) indoorOutdoor = 'both';
      else if (hasIndoor) indoorOutdoor = 'indoor';
      else if (hasOutdoor) indoorOutdoor = 'outdoor';
    }

    // Extract surface/feature types from courts
    const courtFeatures = padelCourts.map(r => r.properties?.resource_feature).filter(Boolean);
    const surfaceType = courtFeatures.length > 0 ? [...new Set(courtFeatures)].join(', ') : null;

    // Extract opening hours
    const openingHours = t.opening_hours || null;

    // Extract images
    const images = (t.images || []).map(img => {
      if (typeof img === 'string') return img;
      return img.url || img.image_url || null;
    }).filter(Boolean);

    return {
      name: t.tenant_name || t.name || '',
      address: [t.address?.street, t.address?.postal_code, t.address?.city].filter(Boolean).join(', '),
      city: t.address?.city || '',
      postcode: extractUKPostcode(
        [t.address?.street, t.address?.postal_code, t.address?.city].filter(Boolean).join(', ')
      ) || (t.address?.postal_code || null),
      region: t.address?.sub_administrative_area || '',
      country: t.address?.country || countryCode.toUpperCase(),
      country_code: countryCode.toUpperCase(),
      lat: t.address?.coordinate?.lat || null,
      lng: t.address?.coordinate?.lon || null,
      phone: t.properties?.phone || null,
      website: t.properties?.url || null,
      playtomic_url: `https://playtomic.io/tenant/${t.tenant_id}`,
      matchi_url: null,
      courts_total: courtCount,
      indoor_outdoor: indoorOutdoor,
      surface_type: surfaceType,
      source: 'playtomic',
      place_id: null,
      status: 'pending',
      opened_year: null,
      notes: '',
      padeli_listing_id: null,
      // Rich Playtomic data (new fields)
      playtomic_tenant_id: t.tenant_id || null,
      playtomic_status: t.playtomic_status || t.tenant_status || null,
      booking_type: t.booking_type || null,
      timezone: t.address?.timezone || null,
      currency: t.default_currency || null,
      opening_hours_raw: openingHours,
      images: images,
      court_details: padelCourts.map(r => ({
        name: r.name || null,
        type: r.properties?.resource_type || null,
        size: r.properties?.resource_size || null,
        feature: r.properties?.resource_feature || null,
        bookable_online: r.booking_settings?.is_bookable_online || false,
      })),
      cancellation_policy: t.default_cancelation_policy || null,
    };
  });
}

/**
 * Fetch clubs from the Matchi API for a given country code.
 * Matchi uses lowercase country codes (e.g. 'gb', 'se', 'de').
 */
async function fetchMatchi(countryCode) {
  console.log(`[matchi] Fetching clubs for country: ${countryCode}...`);

  const body = new URLSearchParams({
    country: countryCode.toLowerCase(),
    sport: 'padel',
  });

  const data = await fetchWithRetry('https://www.matchi.se/facilities/findFacilities?asJson=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  // Matchi can return an object with a facilities array or just an array
  const facilities = Array.isArray(data) ? data : (data?.facilities || []);

  console.log(`[matchi] Found ${facilities.length} raw results.`);

  return facilities.map((f) => ({
    name: f.name || '',
    address: f.address || '',
    city: f.city || '',
    postcode: f.zipcode || extractUKPostcode(f.address || '') || null,
    region: '',
    country: f.country || countryCode.toUpperCase(),
    country_code: countryCode.toUpperCase(),
    lat: f.lat || null,
    lng: f.lng || f.lon || null,
    phone: f.phone || null,
    website: f.website || f.url || null,
    playtomic_url: null,
    matchi_url: f.shortname ? `https://www.matchi.se/facilities/${f.shortname}` : (f.url ? `https://www.matchi.se${f.url}` : null),
    courts_total: f.courts || f.numberOfCourts || null,
    indoor_outdoor: f.indoor ? 'indoor' : (f.outdoor ? 'outdoor' : null),
    surface_type: f.surface || null,
    source: 'matchi',
    place_id: null,
    status: 'pending',
    opened_year: null,
    notes: '',
    padeli_listing_id: null,
  }));
}

/**
 * Fetch padel clubs from Google Places API (New) searchText endpoint.
 * Searches for "padel courts in {location}" and "padel club {location}".
 * Supports city-level queries when cities array is provided.
 * Implements pagination via nextPageToken (max 3 pages per query, 60 results).
 * Requires GOOGLE_PLACES_API_KEY env var — gracefully skips if not set.
 *
 * @param {string} countryCode
 * @param {object} [options]
 * @param {string[]} [options.cities]  When provided, queries per city instead of per country
 */
/**
 * Country bounding boxes (lat/lng) for geographic grid scanning.
 * Format: { minLat, maxLat, minLng, maxLng }
 */
const COUNTRY_BOUNDS = {
  AU: { minLat: -43.6, maxLat: -10.7, minLng: 113.2, maxLng: 153.6 },
  US: { minLat: 24.5, maxLat: 49.4, minLng: -124.8, maxLng: -66.9 },
  GB: { minLat: 49.9, maxLat: 58.7, minLng: -8.2, maxLng: 1.8 },
  ES: { minLat: 36.0, maxLat: 43.8, minLng: -9.3, maxLng: 4.3 },
  SE: { minLat: 55.3, maxLat: 69.1, minLng: 11.1, maxLng: 24.2 },
  ID: { minLat: -11.0, maxLat: 6.1, minLng: 95.0, maxLng: 141.0 },
  AE: { minLat: 22.6, maxLat: 26.1, minLng: 51.5, maxLng: 56.4 },
  TH: { minLat: 5.6, maxLat: 20.5, minLng: 97.3, maxLng: 105.6 },
  PT: { minLat: 36.9, maxLat: 42.2, minLng: -9.5, maxLng: -6.2 },
  IT: { minLat: 36.6, maxLat: 47.1, minLng: 6.6, maxLng: 18.5 },
  FR: { minLat: 41.3, maxLat: 51.1, minLng: -5.1, maxLng: 9.6 },
  DE: { minLat: 47.3, maxLat: 55.1, minLng: 5.9, maxLng: 15.0 },
  // Add more as needed — any country without bounds falls back to city list
};

/**
 * Grid spacing per country. Smaller = more thorough, larger = faster.
 * Dense padel countries (ES, IT, FR, PT) get tight grids.
 * Large sparse countries (AU, US, ID) get wider grids — city queries fill the gaps.
 */
const GRID_SPACING_KM = {
  ES: 40,   // Padel everywhere — tight grid
  IT: 45,   // Growing fast
  FR: 50,   // Growing fast
  PT: 40,   // Dense padel culture
  SE: 50,   // Concentrated in south
  DE: 50,   // Growing market
  GB: 45,   // Growing fast
  AE: 40,   // Small country, tight grid
  TH: 60,   // Concentrated in cities
  AU: 80,   // Huge country, sparse — city queries do the heavy lifting
  US: 80,   // Huge country — city queries cover metros, grid catches the rest
  ID: 70,   // Archipelago — many grid points hit water, wider spacing OK
};

/**
 * Generate a grid of lat/lng center points covering a country's bounding box.
 * Uses country-specific spacing for efficiency.
 *
 * @param {string} countryCode
 * @param {number} [overrideSpacingKm] - Override the default spacing
 * @returns {Array<{lat: number, lng: number}>}
 */
function generateGrid(countryCode, overrideSpacingKm) {
  const cc = countryCode.toUpperCase();
  const bounds = COUNTRY_BOUNDS[cc];
  if (!bounds) return [];

  const spacingKm = overrideSpacingKm || GRID_SPACING_KM[cc] || 50;
  const points = [];
  // 1 degree latitude ≈ 111 km
  const latStep = spacingKm / 111;

  for (let lat = bounds.minLat; lat <= bounds.maxLat; lat += latStep) {
    // 1 degree longitude ≈ 111 * cos(lat) km
    const lngStep = spacingKm / (111 * Math.cos(lat * Math.PI / 180));
    for (let lng = bounds.minLng; lng <= bounds.maxLng; lng += lngStep) {
      points.push({ lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 });
    }
  }

  return points;
}

async function fetchGooglePlaces(countryCode, options = {}) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.log(`[google_places] GOOGLE_PLACES_API_KEY not set — skipping Google Places discovery.`);
    return [];
  }

  const country = countryName(countryCode);
  const cities = options.cities || [];
  const cc = countryCode.toUpperCase();

  // Strategy: use grid scanning if bounds are available, PLUS city-based queries
  const skipGrid = options.skipGrid !== false; // default: skip grid (cost savings), pass skipGrid: false to enable
  const gridPoints = skipGrid ? [] : generateGrid(cc);
  const useGrid = gridPoints.length > 0;

  // Phase 1: Grid-based scanning (geographic coverage of entire country)
  const allResults = [];
  const seenIds = new Set();
  const MAX_PAGES = 3;

  const fieldMask = [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.rating',
    'places.userRatingCount',
    'places.types',
    'places.location',
    'places.nationalPhoneNumber',
    'places.websiteUri',
    'places.addressComponents',
    'nextPageToken',
  ].join(',');

  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': apiKey.replace(/^['"]|['"]$/g, ''),
    'X-Goog-FieldMask': fieldMask,
    'Referer': 'https://padeli.com/',
    'Origin': 'https://padeli.com',
  };

  // Helper to run a single text search query with pagination
  async function searchQuery(query, locationBias) {
    let pageToken = null;
    let page = 0;
    let found = 0;

    do {
      try {
        const bodyObj = { textQuery: query, pageSize: 20, languageCode: 'en' };
        if (pageToken) bodyObj.pageToken = pageToken;
        if (locationBias) bodyObj.locationBias = locationBias;

        const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyObj),
        });

        if (!res.ok) {
          const text = await res.text();
          if (res.status === 429) {
            // Rate limited — wait and retry once
            console.log(`[google_places] Rate limited, waiting 5s...`);
            await new Promise(r => setTimeout(r, 5000));
            continue;
          }
          break;
        }

        const data = await res.json();
        const places = data.places || [];

        for (const p of places) {
          if (seenIds.has(p.id)) continue;
          seenIds.add(p.id);
          allResults.push(p);
          found++;
        }

        pageToken = data.nextPageToken || null;
        page++;

        if (pageToken && page < MAX_PAGES) {
          await new Promise(r => setTimeout(r, 2000));
        }
      } catch (err) {
        break;
      }
    } while (pageToken && page < MAX_PAGES);

    return found;
  }

  if (useGrid) {
    console.log(`[google_places] Grid scanning ${cc}: ${gridPoints.length} grid points (50km spacing, 30km search radius)...`);

    let gridSearches = 0;
    let emptyStreak = 0;

    for (let i = 0; i < gridPoints.length; i++) {
      const pt = gridPoints[i];
      const locationBias = {
        circle: {
          center: { latitude: pt.lat, longitude: pt.lng },
          radius: 30000.0, // 30km radius
        },
      };

      const found = await searchQuery('padel', locationBias);
      gridSearches++;

      if (found > 0) {
        emptyStreak = 0;
        // Log progress every time we find results
        if (gridSearches % 20 === 0 || found > 5) {
          console.log(`[google_places] Grid ${i + 1}/${gridPoints.length}: +${found} new (${allResults.length} total unique)`);
        }
      } else {
        emptyStreak++;
      }

      // Rate limit: 300ms between requests
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[google_places] Grid scan complete: ${gridSearches} areas searched, ${allResults.length} unique results so far.`);
  }

  // Phase 2: City-based queries (catches anything the grid missed + different query terms)
  const locations = cities.length > 0
    ? cities.map(c => `${c}, ${country}`)
    : [country];

  const queryTemplates = ['padel courts in', 'padel club'];
  const queries = [];
  for (const location of locations) {
    for (const template of queryTemplates) {
      queries.push(`${template} ${location}`);
    }
  }

  console.log(`[google_places] City queries: ${queries.length} queries (${cities.length > 0 ? cities.length + ' cities' : 'country-level'})...`);

  for (const query of queries) {
    const found = await searchQuery(query, null);
    if (found > 0) {
      console.log(`[google_places] "${query}" → +${found} new`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[google_places] ${allResults.length} unique results after all searches.`);

  // Map to the 21-field schema
  return allResults.map((p) => {
    const displayName = (p.displayName || {}).text || '';
    const addr = p.formattedAddress || '';

    // Extract city from addressComponents (locality type)
    const locality = p.addressComponents?.find(c => c.types?.includes('locality'));
    const city = locality?.longText || '';

    return {
      name: displayName,
      address: addr,
      city,
      postcode: extractUKPostcode(addr) || null,
      region: '',
      country: countryName(countryCode),
      country_code: countryCode.toUpperCase(),
      lat: p.location?.latitude || null,
      lng: p.location?.longitude || null,
      phone: p.nationalPhoneNumber || null,
      website: p.websiteUri || null,
      playtomic_url: null,
      matchi_url: null,
      courts_total: null,
      indoor_outdoor: null,
      surface_type: null,
      source: 'google_places',
      place_id: p.id || null,
      status: 'pending',
      opened_year: null,
      notes: '',
      padeli_listing_id: null,
    };
  });
}

/**
 * Google Custom Search stub — placeholder for future implementation.
 * Requires GOOGLE_CSE_ID and GOOGLE_API_KEY env vars.
 */
async function fetchGoogleSearch(countryCode) {
  console.log(`[google_search] Google Custom Search not yet configured — needs GOOGLE_CSE_ID and GOOGLE_API_KEY`);
  return [];
}

/**
 * LTA Court Finder stub — UK only.
 * Returns empty array. Future implementation will scrape LTA's court finder.
 */
async function fetchLTACourtFinder() {
  console.log(`[lta] LTA Court Finder scraping not yet implemented — requires HTML parsing`);
  return [];
}

/**
 * Federation directory stub — scrapes national padel federation directories.
 * Returns empty array. Future implementation per country.
 */
async function fetchFederationDirectory(countryCode) {
  console.log(`[federation] Federation directory scraping not yet implemented for ${countryCode.toUpperCase()}`);
  return [];
}

/**
 * Instagram discovery stub — finds padel clubs via Instagram search/hashtags.
 * Returns empty array.
 */
async function fetchInstagramDiscovery(countryCode) {
  return [];
}

// ─── Playtomic Name Search ───────────────────────────────────────────────

/**
 * Search Playtomic for a specific venue by name (and optionally country).
 * Returns the tenant object if found, or null.
 *
 * Uses the Playtomic search API which supports a query parameter.
 * Falls back to fetching the full country tenant list and matching by name.
 *
 * @param {string} name - Venue name to search for
 * @param {string} [countryCode] - ISO country code to narrow results
 * @returns {Promise<{ playtomic_url: string, tenant_id: string, tenant_name: string, courts: number|null } | null>}
 */
async function searchPlaytomicByName(name, countryCode) {
  if (!name) return null;

  const normalizedSearch = name.toLowerCase().replace(/[^a-z0-9]/g, '');

  try {
    // Fetch all tenants for the country with pagination
    const baseUrl = countryCode
      ? `https://api.playtomic.io/v1/tenants?sport_id=PADEL&country_code=${countryCode.toUpperCase()}&size=500`
      : `https://api.playtomic.io/v1/tenants?sport_id=PADEL&size=500`;

    const data = [];
    let page = 0;
    while (true) {
      const pageData = await fetchWithRetry(`${baseUrl}&page=${page}`);
      if (!Array.isArray(pageData) || pageData.length === 0) break;
      data.push(...pageData);
      if (pageData.length < 200) break;
      page++;
      await new Promise(r => setTimeout(r, 300));
    }

    if (data.length > 0) {
      // Find best match — prioritise prefix/substring matches heavily over fuzzy
      let bestMatch = null;
      let bestScore = 0;

      for (const t of data) {
        const tName = (t.tenant_name || t.name || '').trim();
        const tNorm = tName.toLowerCase().replace(/[^a-z0-9]/g, '');
        let score = 0;

        // Tier 1: Exact normalized match (highest priority)
        if (tNorm === normalizedSearch) {
          score = 2.0;
        }
        // Tier 2: Search name is a prefix of Playtomic name (e.g. "ipadel" → "ipadelmelbourne")
        else if (tNorm.startsWith(normalizedSearch)) {
          score = 1.5 + (normalizedSearch.length / tNorm.length) * 0.3;
        }
        // Tier 3: Playtomic name is a prefix of search name
        else if (normalizedSearch.startsWith(tNorm) && tNorm.length >= 4) {
          score = 1.3 + (tNorm.length / normalizedSearch.length) * 0.3;
        }
        // Tier 4: Substring match (either direction, non-prefix)
        else if (tNorm.includes(normalizedSearch) || normalizedSearch.includes(tNorm)) {
          score = 1.0 + stringSimilarity(name, tName) * 0.3;
        }
        // Tier 5: Fuzzy only — needs higher threshold (0.75) to avoid false matches
        else {
          const sim = stringSimilarity(name, tName);
          if (sim > 0.75) {
            score = sim;
          }
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = t;
        }
      }

      if (bestMatch && !isBlocklistedTenant(bestMatch.tenant_id)) {
        const padelCourts = (bestMatch.resources || []).filter(r => r.sport_id === 'PADEL' && r.is_active !== false);
        const courtTypes = padelCourts.map(r => r.properties?.resource_type).filter(Boolean);
        let indoorOutdoor = null;
        if (courtTypes.length > 0) {
          const hasIndoor = courtTypes.some(t => t === 'indoor');
          const hasOutdoor = courtTypes.some(t => t === 'outdoor' || t === 'roofed');
          if (hasIndoor && hasOutdoor) indoorOutdoor = 'both';
          else if (hasIndoor) indoorOutdoor = 'indoor';
          else if (hasOutdoor) indoorOutdoor = 'outdoor';
        }
        return {
          playtomic_url: `https://playtomic.io/tenant/${bestMatch.tenant_id}`,
          tenant_id: bestMatch.tenant_id,
          tenant_name: (bestMatch.tenant_name || bestMatch.name || '').trim(),
          courts: padelCourts.length || bestMatch.properties?.number_of_courts || null,
          indoor_outdoor: indoorOutdoor,
          opening_hours_raw: bestMatch.opening_hours || null,
          images: (bestMatch.images || []).map(img => typeof img === 'string' ? img : (img.url || img.image_url || null)).filter(Boolean),
          timezone: bestMatch.address?.timezone || null,
          booking_type: bestMatch.booking_type || null,
          court_details: padelCourts.map(r => ({
            name: r.name || null,
            type: r.properties?.resource_type || null,
            feature: r.properties?.resource_feature || null,
          })),
        };
      }
    }
  } catch (err) {
    // Silent failure — this is a best-effort enhancement
    console.log(`  [playtomic-search] Search failed for "${name}": ${err.message}`);
  }

  return null;
}

/**
 * Fetch a single Playtomic tenant by ID. Returns the full rich data object.
 * Use when you already have a tenant_id (from URL or discovery) and want
 * all the venue details: courts, opening hours, images, facilities, etc.
 *
 * @param {string} tenantId - Playtomic tenant UUID
 * @returns {Promise<object|null>} - Rich venue data or null
 */
async function fetchPlaytomicTenant(tenantId) {
  if (!tenantId) return null;

  try {
    const url = `https://api.playtomic.io/v1/tenants/${tenantId}`;
    const t = await fetchWithRetry(url);
    if (!t || !t.tenant_id) return null;
    if (isBlocklistedTenant(t.tenant_id)) return null;

    // Extract court data from resources[]
    const padelCourts = (t.resources || []).filter(r => r.sport_id === 'PADEL' && r.is_active !== false);

    // Indoor/outdoor classification
    const courtTypes = padelCourts.map(r => r.properties?.resource_type).filter(Boolean);
    let indoorOutdoor = null;
    if (courtTypes.length > 0) {
      const hasIndoor = courtTypes.some(ct => ct === 'indoor');
      const hasOutdoor = courtTypes.some(ct => ct === 'outdoor' || ct === 'roofed');
      if (hasIndoor && hasOutdoor) indoorOutdoor = 'both';
      else if (hasIndoor) indoorOutdoor = 'indoor';
      else if (hasOutdoor) indoorOutdoor = 'outdoor';
    }

    // Surface/feature types
    const courtFeatures = padelCourts.map(r => r.properties?.resource_feature).filter(Boolean);
    const surfaceType = courtFeatures.length > 0 ? [...new Set(courtFeatures)].join(', ') : null;

    // Images
    const images = (t.images || []).map(img =>
      typeof img === 'string' ? img : (img.url || img.image_url || null)
    ).filter(Boolean);

    // All sports offered (for multi-sport venues)
    const sportsOffered = (t.sport_ids || []).filter(s => s !== 'PADEL');

    return {
      tenant_id: t.tenant_id,
      tenant_name: (t.tenant_name || t.name || '').trim(),
      playtomic_url: `https://playtomic.io/tenant/${t.tenant_id}`,
      playtomic_status: t.playtomic_status || t.tenant_status || null,
      booking_type: t.booking_type || null,
      courts: padelCourts.length || null,
      indoor_outdoor: indoorOutdoor,
      surface_type: surfaceType,
      timezone: t.address?.timezone || null,
      currency: t.default_currency || null,
      opening_hours_raw: t.opening_hours || null,
      images,
      court_details: padelCourts.map(r => ({
        name: r.name || null,
        type: r.properties?.resource_type || null,
        size: r.properties?.resource_size || null,
        feature: r.properties?.resource_feature || null,
        bookable_online: r.booking_settings?.is_bookable_online || false,
        allows_onsite_payment: r.booking_settings?.allows_onsite_payment || false,
        durations: r.booking_settings?.allowed_duration_increments || [],
      })),
      cancellation_policy: t.default_cancelation_policy || null,
      other_sports: sportsOffered,
      address: {
        street: t.address?.street || null,
        city: t.address?.city || null,
        postal_code: t.address?.postal_code || null,
        region: t.address?.sub_administrative_area || null,
        country: t.address?.country || null,
        lat: t.address?.coordinate?.lat || null,
        lng: t.address?.coordinate?.lon || null,
      },
    };
  } catch (err) {
    console.log(`  [playtomic] Tenant fetch failed for ${tenantId}: ${err.message}`);
    return null;
  }
}

/**
 * Backfill Playtomic URLs for venues discovered via non-Playtomic sources.
 * Searches Playtomic by name for each venue missing a playtomic_url.
 *
 * @param {object[]} clubs - Array of club objects (mutated in place)
 * @param {string} countryCode - ISO country code
 * @returns {Promise<number>} Number of URLs backfilled
 */
async function backfillPlaytomicUrls(clubs, countryCode) {
  const needBackfill = clubs.filter(c => !c.playtomic_url && c.source !== 'playtomic');
  if (needBackfill.length === 0) return 0;

  console.log(`[playtomic-backfill] ${needBackfill.length} venues missing Playtomic URL — searching...`);
  let found = 0;

  for (const club of needBackfill) {
    const result = await searchPlaytomicByName(club.name, countryCode);
    if (result) {
      club.playtomic_url = result.playtomic_url;
      club.courts_total = club.courts_total || result.courts;
      if (!club.source.includes('playtomic')) {
        club.source = club.source ? `${club.source}+playtomic` : 'playtomic';
      }
      found++;
      console.log(`  [playtomic-backfill] "${club.name}" → ${result.tenant_name} (${result.playtomic_url})`);
    }
    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`[playtomic-backfill] ${found} of ${needBackfill.length} backfilled.`);
  return found;
}

// ─── Deduplication ───────────────────────────────────────────────────────────

/**
 * Deduplicate clubs by name + city with fuzzy matching (>85% similarity).
 * When duplicates are found, merge them (prefer earlier data, mark source as 'both' or 'multiple').
 */
function deduplicateClubs(clubs) {
  const unique = [];

  for (const club of clubs) {
    const duplicate = unique.find((existing) => {
      // Same city check (exact or very similar)
      // If either city is empty, fall back to address similarity or skip city check
      const cityMatch =
        (!existing.city && !club.city) ||
        existing.city.toLowerCase() === club.city.toLowerCase() ||
        stringSimilarity(existing.city, club.city) > 0.85;

      if (!cityMatch) return false;

      // Check both raw names AND brand-normalized names
      const rawSim = stringSimilarity(existing.name, club.name);
      if (rawSim > 0.85) return true;
      // Try brand-normalized names for abbreviation matching (G4P = Game4Padel etc.)
      const normSim = stringSimilarity(normalizeBrandName(existing.name), normalizeBrandName(club.name));
      return normSim > 0.85;
    });

    if (duplicate) {
      // Merge: keep existing record but fill in missing fields and update source
      const sources = new Set((duplicate.source || '').split('+').concat((club.source || '').split('+')));
      duplicate.source = sources.size > 1 ? [...sources].join('+') : [...sources][0];
      duplicate.matchi_url = duplicate.matchi_url || club.matchi_url;
      duplicate.playtomic_url = duplicate.playtomic_url || club.playtomic_url;
      duplicate.phone = duplicate.phone || club.phone;
      duplicate.website = duplicate.website || club.website;
      duplicate.courts_total = duplicate.courts_total || club.courts_total;
      duplicate.indoor_outdoor = duplicate.indoor_outdoor || club.indoor_outdoor;
      duplicate.surface_type = duplicate.surface_type || club.surface_type;
      duplicate.lat = duplicate.lat || club.lat;
      duplicate.lng = duplicate.lng || club.lng;
      duplicate.postcode = duplicate.postcode || club.postcode;
      duplicate.place_id = duplicate.place_id || club.place_id;
      duplicate.city = duplicate.city || club.city;
    } else {
      unique.push({ ...club });
    }
  }

  return unique;
}

// ─── Valid Sources ────────────────────────────────────────────────────────────

const ALL_SOURCE_NAMES = ['playtomic', 'matchi', 'google_places', 'google_search', 'lta', 'federation', 'instagram'];
const NON_STUB_SOURCES = ['playtomic', 'matchi', 'google_places'];

// ─── Main Export ─────────────────────────────────────────────────────────────

/**
 * Discover padel clubs for a given country code.
 *
 * @param {string} countryCode - ISO 2-letter country code (e.g. 'GB', 'US', 'DE')
 * @param {object} options
 * @param {string[]} options.sources - Which sources to use. Default: ['playtomic']
 *   Valid: 'playtomic', 'matchi', 'google_places', 'google_search', 'lta', 'federation', 'instagram'
 * @param {boolean} options.includeMatchi - Shorthand to add Matchi as a source. Default: false
 * @param {boolean} options.allSources - Enable all non-stub sources (playtomic + matchi + google_places). Default: false
 * @returns {Promise<object[]>} Array of club objects sorted by country, city, name
 */
async function discoverClubs(countryCode, options = {}) {
  const { sources = ['playtomic'], includeMatchi = false, allSources = false, cities = [] } = options;

  // Build the list of sources to query
  let activeSources;
  if (allSources) {
    activeSources = [...NON_STUB_SOURCES];
  } else {
    activeSources = [...sources];
    if (includeMatchi && !activeSources.includes('matchi')) {
      activeSources.push('matchi');
    }
  }

  console.log(`\n=== Padel Club Discovery ===`);
  console.log(`Country: ${countryCode.toUpperCase()}`);
  console.log(`Sources: ${activeSources.join(', ')}`);
  if (cities.length > 0) console.log(`Cities:  ${cities.join(', ')}`);
  console.log('');

  // Fetch from each source
  let allClubs = [];

  if (activeSources.includes('playtomic')) {
    try {
      const playtomicClubs = await fetchPlaytomic(countryCode);
      allClubs = allClubs.concat(playtomicClubs);
    } catch (err) {
      console.error(`[playtomic] ERROR: ${err.message} — skipping Playtomic.`);
    }
  }

  if (activeSources.includes('matchi')) {
    try {
      const matchiClubs = await fetchMatchi(countryCode);
      allClubs = allClubs.concat(matchiClubs);
    } catch (err) {
      console.error(`[matchi] ERROR: ${err.message} — skipping Matchi.`);
    }
  }

  if (activeSources.includes('google_places')) {
    try {
      const googleClubs = await fetchGooglePlaces(countryCode, { cities });
      allClubs = allClubs.concat(googleClubs);
    } catch (err) {
      console.error(`[google_places] ERROR: ${err.message} — skipping Google Places.`);
    }
  }

  if (activeSources.includes('google_search')) {
    try {
      const googleSearchClubs = await fetchGoogleSearch(countryCode);
      allClubs = allClubs.concat(googleSearchClubs);
    } catch (err) {
      console.error(`[google_search] ERROR: ${err.message} — skipping Google Search.`);
    }
  }

  if (activeSources.includes('lta')) {
    try {
      const ltaClubs = await fetchLTACourtFinder();
      allClubs = allClubs.concat(ltaClubs);
    } catch (err) {
      console.error(`[lta] ERROR: ${err.message} — skipping LTA.`);
    }
  }

  if (activeSources.includes('federation')) {
    try {
      const fedClubs = await fetchFederationDirectory(countryCode);
      allClubs = allClubs.concat(fedClubs);
    } catch (err) {
      console.error(`[federation] ERROR: ${err.message} — skipping federation directory.`);
    }
  }

  if (activeSources.includes('instagram')) {
    try {
      const igClubs = await fetchInstagramDiscovery(countryCode);
      allClubs = allClubs.concat(igClubs);
    } catch (err) {
      console.error(`[instagram] ERROR: ${err.message} — skipping Instagram.`);
    }
  }

  console.log(`\n[total] ${allClubs.length} clubs fetched from all sources.`);

  // Filter out noise (tennis-only, equipment shops, coaches, federations, etc.)
  const filtered = [];
  const warnings = [];

  for (const club of allClubs) {
    const noiseResult = isNoise(club.name);

    if (noiseResult === 'coming_soon') {
      // Keep in pool but flag as warning — not a hard drop
      club.status = 'coming_soon';
      club.notes = 'Name suggests venue is not yet open — verify before listing';
      filtered.push(club);
      warnings.push(`  [warning] "${club.name}" — coming soon / under construction, kept with flag`);
    } else if (noiseResult === true) {
      // Hard drop — noise
    } else {
      filtered.push(club);
    }
  }

  console.log(`[filter] ${allClubs.length - filtered.length} noisy entries removed, ${filtered.length} remaining.`);
  if (warnings.length > 0) {
    console.log(`[filter] ${warnings.length} "coming soon" entries flagged:`);
    warnings.forEach((w) => console.log(w));
  }

  // Deduplicate on name + city
  const deduped = deduplicateClubs(filtered);
  console.log(`[dedup] ${filtered.length - deduped.length} duplicates merged, ${deduped.length} unique clubs.`);

  // Backfill Playtomic URLs for venues found via other sources
  if (activeSources.includes('playtomic') && !options.skipBackfill) {
    await backfillPlaytomicUrls(deduped, countryCode);
  } else if (options.skipBackfill) {
    console.log(`[playtomic-backfill] Skipped (--skip-backfill flag).`);
  }

  // Sort by country, then city, then name
  deduped.sort((a, b) => {
    const countryCompare = a.country_code.localeCompare(b.country_code);
    if (countryCompare !== 0) return countryCompare;
    const cityCompare = a.city.localeCompare(b.city);
    if (cityCompare !== 0) return cityCompare;
    return a.name.localeCompare(b.name);
  });

  // Assign pool_id (auto-increment per club in results)
  for (let i = 0; i < deduped.length; i++) {
    deduped[i].pool_id = i + 1;
  }

  console.log(`\n[done] Returning ${deduped.length} padel clubs for ${countryCode.toUpperCase()}.\n`);

  return deduped;
}

// ─── Discover and Enrich ─────────────────────────────────────────────────────

/**
 * Convenience function: discover clubs then enrich with Google Place IDs.
 *
 * 1. Calls discoverClubs() with the given options
 * 2. For each club missing a place_id, calls lookupPlaceId() to populate
 *    place_id, google_rating, google_review_count
 * 3. Returns the enriched array
 *
 * @param {string} countryCode - ISO 2-letter country code
 * @param {object} options - Same options as discoverClubs, plus:
 * @param {number} options.enrichDelayMs - Delay between Place ID lookups in ms (default: 300)
 * @returns {Promise<object[]>} Enriched club array
 */
async function discoverAndEnrich(countryCode, options = {}) {
  const { enrichDelayMs = 300, ...discoverOptions } = options;

  // Step 1: Discover
  const clubs = await discoverClubs(countryCode, discoverOptions);

  // Check if Google Places API key is available for enrichment
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.log(`[enrich] GOOGLE_PLACES_API_KEY not set — skipping Place ID enrichment.`);
    return clubs;
  }

  // Step 2: Enrich clubs missing place_id
  const needEnrichment = clubs.filter((c) => !c.place_id);
  console.log(`[enrich] ${needEnrichment.length} of ${clubs.length} clubs need Place ID lookup...`);

  let enriched = 0;
  let failed = 0;

  for (const club of needEnrichment) {
    const queryParts = [club.name, club.address].filter(Boolean).join(' ').trim();
    if (!queryParts) {
      failed++;
      continue;
    }

    try {
      const result = await lookupPlaceId(club.name, club.address);
      if (result) {
        club.place_id = result.placeId;
        club.google_rating = result.rating;
        club.google_review_count = result.reviewCount;
        enriched++;
      } else {
        failed++;
      }
    } catch {
      failed++;
    }

    // Rate limiting
    if (enrichDelayMs > 0) {
      await new Promise((r) => setTimeout(r, enrichDelayMs));
    }
  }

  console.log(`[enrich] Done: ${enriched} enriched, ${failed} not found, ${clubs.length - needEnrichment.length} already had place_id.`);

  return clubs;
}

// ─── Discover and Save ──────────────────────────────────────────────────────

/**
 * Bridge function: discover clubs then persist to the master sheet.
 *
 * @param {string} countryCode - ISO 2-letter country code
 * @param {object} options - Same options as discoverClubs
 * @returns {Promise<{ added: number, skipped: number, total: number, discovered: number }>}
 */
async function discoverAndSave(countryCode, options = {}) {
  const masterSheet = require('./master-sheet');

  // Step 1: Discover
  const clubs = await discoverClubs(countryCode, options);

  if (clubs.length === 0) {
    console.log(`[save] No clubs discovered — nothing to save.`);
    return { discovered: 0, added: 0, skipped: 0, total: 0 };
  }

  // Step 2: Save to master sheet
  console.log(`[save] Persisting ${clubs.length} discovered clubs to master sheet...`);
  const result = masterSheet.addClubs(countryCode, clubs);

  console.log(`[save] Done: ${result.added} added, ${result.skipped} duplicates skipped, ${result.total} total in sheet.`);

  return { discovered: clubs.length, clubs, ...result };
}

// ─── CLI Interface ──────────────────────────────────────────────────────────

if (require.main === module) {
  const { afterDiscoveryPipeline } = require('./notion-sync');
  const args = process.argv.slice(2);
  const command = args[0];
  const countryCode = args[1];

  if (!command || !countryCode) {
    console.log('Usage:');
    console.log('  node discover-clubs.js discover <CC>                # country-level discovery');
    console.log('  node discover-clubs.js discover <CC> --cities       # city-level for large countries');
    console.log('  node discover-clubs.js save <CC>                    # discover + save to master sheet');
    console.log('  node discover-clubs.js save <CC> --cities           # discover with cities + save');
    process.exit(1);
  }

  const cc = countryCode.toUpperCase();
  const useCities = args.includes('--cities');
  const cities = useCities ? (COUNTRY_CITIES[cc] || []) : [];

  if (useCities && cities.length === 0) {
    console.log(`[warn] No built-in city list for ${cc}. Falling back to country-level queries.`);
  }

  const skipBackfill = args.includes('--skip-backfill');
  const opts = { allSources: true, cities, skipBackfill };

  (async () => {
    try {
      if (command === 'discover') {
        const clubs = await discoverClubs(cc, opts);
        await afterDiscoveryPipeline(cc, clubs, opts.allSources ? 'all' : 'playtomic');
        console.log(JSON.stringify(clubs, null, 2));
      } else if (command === 'save') {
        const result = await discoverAndSave(cc, opts);
        await afterDiscoveryPipeline(cc, result.clubs || [], opts.allSources ? 'all' : 'playtomic');
        console.log(`\n=== Save Summary ===`);
        console.log(`  Discovered: ${result.discovered}`);
        console.log(`  Added:      ${result.added}`);
        console.log(`  Skipped:    ${result.skipped} (duplicates)`);
        console.log(`  Total:      ${result.total}`);
      } else {
        console.error(`Unknown command: ${command}`);
        console.log('Commands: discover, save');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Fatal error: ${err.message}`);
      process.exit(1);
    }
  })();
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  discoverClubs,
  discoverAndEnrich,
  discoverAndSave,
  stringSimilarity,
  normalizeBrandName,
  isNoise,
  extractUKPostcode,
  searchPlaytomicByName,
  fetchPlaytomicTenant,
  backfillPlaytomicUrls,
  // Individual fetchers (for advanced usage / testing)
  fetchGooglePlaces,
  fetchGoogleSearch,
  fetchLTACourtFinder,
  fetchFederationDirectory,
  fetchInstagramDiscovery,
  // Constants
  ALL_SOURCE_NAMES,
  NON_STUB_SOURCES,
  COUNTRY_CITIES,
};
