const axios = require('axios');
const env = require('../config/env');

const SERPAPI_LENS_URL = 'https://serpapi.com/search.json';

const SUPPLIER_PATTERNS = [
  { id: 'aliexpress', label: 'AliExpress', patterns: [/aliexpress\./i, /aliexpress/i] },
  { id: '1688', label: '1688', patterns: [/1688\.com/i, /\b1688\b/i] },
  { id: 'amazon', label: 'Amazon', patterns: [/amazon\./i, /\bamazon\b/i] },
  { id: 'trendyol', label: 'Trendyol', patterns: [/trendyol\./i, /trendyol/i] },
  { id: 'noon', label: 'Noon', patterns: [/noon\./i, /\bnoon\b/i] },
];

/** Marketplace defaults when SerpAPI omits shipping/rating fields. */
const SUPPLIER_DEFAULTS = {
  aliexpress: { shippingCost: 5, shippingDays: 18, rating: 4.3 },
  '1688': { shippingCost: 8, shippingDays: 25, rating: 4.1 },
  amazon: { shippingCost: 0, shippingDays: 3, rating: 4.5 },
  trendyol: { shippingCost: 3, shippingDays: 5, rating: 4.4 },
  noon: { shippingCost: 2, shippingDays: 2, rating: 4.4 },
};

function detectSupplier(link = '', source = '') {
  const haystack = `${link} ${source}`;
  return SUPPLIER_PATTERNS.find((supplier) =>
    supplier.patterns.some((pattern) => pattern.test(haystack))
  ) || null;
}

function parseMoney(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;

  if (typeof value === 'object') {
    const nested = value.extracted_value ?? value.value ?? value.amount;
    if (nested != null) return parseMoney(nested);
    if (typeof value.raw === 'string') return parseMoney(value.raw);
  }

  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    const parsed = Number.parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseShippingDays(match) {
  const candidates = [
    match.delivery,
    match.shipping,
    match.shipping_info,
    match.extensions?.join(' '),
    match.snippet,
  ]
    .filter(Boolean)
    .join(' ');

  const dayMatch = candidates.match(/(\d+)\s*[-–]?\s*(\d+)?\s*(day|days|يوم|أيام)/i);
  if (dayMatch) {
    const min = Number(dayMatch[1]);
    const max = dayMatch[2] ? Number(dayMatch[2]) : min;
    return Math.round((min + max) / 2);
  }

  if (/express|same.?day|next.?day|توصيل سريع/i.test(candidates)) return 2;
  if (/free shipping|شحن مجاني/i.test(candidates)) return null;

  return null;
}

function parseShippingCost(match) {
  const candidates = [
    match.delivery_price,
    match.shipping_price,
    match.shipping_cost,
    match.shipping,
    match.extensions?.join(' '),
  ];

  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === 'string' && /free|مجاني/i.test(candidate)) return 0;
    const parsed = parseMoney(candidate);
    if (parsed != null) return parsed;
  }

  return null;
}

function parseRating(match) {
  const candidates = [
    match.rating,
    match.seller_rating,
    match.reviews?.rating,
    match.source_rating,
  ];

  for (const candidate of candidates) {
    const parsed = parseMoney(candidate);
    if (parsed != null && parsed >= 0 && parsed <= 5) return parsed;
  }

  const text = [match.snippet, ...(match.extensions || [])].filter(Boolean).join(' ');
  const ratingMatch = text.match(/(\d(?:\.\d)?)\s*(?:\/\s*5|stars?|★)/i);
  if (ratingMatch) return Number.parseFloat(ratingMatch[1]);

  return null;
}

function extractReviewSnippets(match) {
  const snippets = [];

  if (typeof match.snippet === 'string' && match.snippet.trim()) {
    snippets.push(match.snippet.trim());
  }

  if (Array.isArray(match.extensions)) {
    for (const extension of match.extensions) {
      if (typeof extension === 'string' && extension.trim().length > 20) {
        snippets.push(extension.trim());
      }
    }
  }

  if (Array.isArray(match.reviews)) {
    for (const review of match.reviews) {
      const text = typeof review === 'string' ? review : review?.text || review?.content;
      if (text && String(text).trim()) snippets.push(String(text).trim());
    }
  }

  return [...new Set(snippets)].slice(0, 8);
}

function normalizeMatch(match, index) {
  const supplier = detectSupplier(match.link, match.source);
  if (!supplier) return null;

  const defaults = SUPPLIER_DEFAULTS[supplier.id];
  const price = parseMoney(match.price?.extracted_value ?? match.price?.value ?? match.price);
  if (price == null) return null;

  const currency =
    match.price?.currency ||
    (typeof match.price === 'string' && match.price.match(/[A-Z]{3}/)?.[0]) ||
    'USD';

  const shippingCost = parseShippingCost(match) ?? defaults.shippingCost;
  const shippingDays = parseShippingDays(match) ?? defaults.shippingDays;
  const rating = parseRating(match) ?? defaults.rating;
  const reviewSnippets = extractReviewSnippets(match);

  return {
    id: `${supplier.id}-${index}`,
    title: match.title || 'Untitled product',
    link: match.link,
    thumbnail: match.thumbnail || null,
    supplier: supplier.id,
    supplierLabel: supplier.label,
    source: match.source || supplier.label,
    price,
    currency,
    shippingCost,
    shippingDays,
    totalPrice: Number((price + shippingCost).toFixed(2)),
    rating: Number(rating.toFixed(2)),
    inStock: match.in_stock ?? null,
    reviewSnippets,
  };
}

function pickDistinctOffers(offers) {
  if (!offers.length) {
    return {
      lowestPrice: null,
      fastestShipping: null,
      highestRating: null,
    };
  }

  const byPrice = [...offers].sort((a, b) => a.totalPrice - b.totalPrice);
  const byShipping = [...offers].sort((a, b) => a.shippingDays - b.shippingDays || a.totalPrice - b.totalPrice);
  const byRating = [...offers].sort((a, b) => b.rating - a.rating || a.totalPrice - b.totalPrice);

  const used = new Set();
  const pick = (sorted) => {
    const preferred = sorted.find((offer) => !used.has(offer.id)) || sorted[0];
    if (preferred) used.add(preferred.id);
    return preferred || null;
  };

  return {
    lowestPrice: pick(byPrice),
    fastestShipping: pick(byShipping),
    highestRating: pick(byRating),
  };
}

/**
 * Perform a visual product search and select the best supplier offers.
 * @param {{ imageUrl?: string, imageBase64?: string }} payload
 */
async function searchByImage({ imageUrl, imageBase64 }) {
  if (!env.serpApiKey) {
    const error = new Error('SERPAPI_KEY is not configured');
    error.status = 503;
    throw error;
  }

  if (!imageUrl && !imageBase64) {
    const error = new Error('Provide either imageUrl or imageBase64');
    error.status = 400;
    throw error;
  }

  const params = {
    engine: 'google_lens',
    api_key: env.serpApiKey,
  };

  if (imageUrl) {
    params.url = imageUrl;
  } else {
    params.image = imageBase64;
  }

  const { data } = await axios.get(SERPAPI_LENS_URL, {
    params,
    timeout: 45000,
  });

  const visualMatches = data.visual_matches || [];
  const shoppingResults = data.shopping_results || [];
  const combined = [...visualMatches, ...shoppingResults];

  const supplierOffers = combined
    .map((match, index) => normalizeMatch(match, index))
    .filter(Boolean);

  const offers = pickDistinctOffers(supplierOffers);
  const selectedOffers = [offers.lowestPrice, offers.fastestShipping, offers.highestRating].filter(
    Boolean
  );

  const productName =
    data.knowledge_graph?.title ||
    selectedOffers[0]?.title ||
    visualMatches[0]?.title ||
    'Unknown product';

  return {
    query: data.search_metadata?.id || null,
    productName,
    knowledgeGraph: data.knowledge_graph || null,
    supplierOfferCount: supplierOffers.length,
    rawResultCount: combined.length,
    offers,
    selectedOffers,
    allSupplierOffers: supplierOffers,
  };
}

module.exports = {
  searchByImage,
  detectSupplier,
  pickDistinctOffers,
};
