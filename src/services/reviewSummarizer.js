const axios = require('axios');
const env = require('../config/env');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        // fall through
      }
    }

    const objectMatch = text.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        // fall through
      }
    }

    return null;
  }
}

/**
 * Summarize and translate product reviews to Arabic using Claude.
 * @param {{
 *   productName: string,
 *   reviews: string[],
 *   supplier?: string,
 *   offerType?: string,
 * }} input
 */
async function summarizeReviews({ productName, reviews, supplier, offerType }) {
  if (!env.anthropicApiKey) {
    const error = new Error('ANTHROPIC_API_KEY is not configured');
    error.status = 503;
    throw error;
  }

  const safeReviews = Array.isArray(reviews)
    ? reviews.map((review) => String(review).trim()).filter(Boolean)
    : [];

  const reviewBlock =
    safeReviews.length > 0
      ? safeReviews.map((review, index) => `${index + 1}. ${review}`).join('\n')
      : 'No customer review text was available. Infer a cautious summary from the product title and marketplace reputation only.';

  const prompt = `You are a bilingual product analyst for a Saudi dropshipping store (Big Win).

Product: ${productName || 'Unknown product'}
Supplier marketplace: ${supplier || 'unknown'}
Offer category: ${offerType || 'general'}

Customer reviews / snippets (may be English, Arabic, Chinese, or Turkish):
${reviewBlock}

Tasks:
1. Analyze the reviews (or available signals if reviews are sparse).
2. Translate and rewrite everything for Arabic-speaking store owners.
3. Keep marketplace names and product model names in their original script when useful.

Respond with valid JSON only using these keys (all string values in Arabic except sentiment):
- summary: 2-3 Arabic sentences overview
- pros: array of up to 5 Arabic strengths
- cons: array of up to 5 Arabic weaknesses
- sentiment: one of "positive", "mixed", or "negative"
- recommendation: brief Arabic buying advice for a Salla store owner
- reviewsArabic: array of up to 5 short Arabic translations of the strongest original review snippets (empty array if none)`;

  const { data } = await axios.post(
    ANTHROPIC_API_URL,
    {
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': env.anthropicApiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    }
  );

  const text = data.content?.[0]?.text?.trim();
  if (!text) {
    const error = new Error('Empty response from Anthropic API');
    error.status = 502;
    throw error;
  }

  const parsed = extractJson(text);
  if (parsed) {
    return {
      summary: parsed.summary || '',
      pros: Array.isArray(parsed.pros) ? parsed.pros : [],
      cons: Array.isArray(parsed.cons) ? parsed.cons : [],
      sentiment: parsed.sentiment || 'mixed',
      recommendation: parsed.recommendation || '',
      reviewsArabic: Array.isArray(parsed.reviewsArabic) ? parsed.reviewsArabic : [],
    };
  }

  return {
    summary: text,
    pros: [],
    cons: [],
    sentiment: 'mixed',
    recommendation: '',
    reviewsArabic: [],
  };
}

/**
 * Build Arabic review summaries for each selected offer in parallel.
 * @param {{ productName: string, offers: object }} input
 */
async function summarizeOffersInArabic({ productName, offers }) {
  const entries = [
    { key: 'lowestPrice', label: 'lowest_price', offer: offers?.lowestPrice },
    { key: 'fastestShipping', label: 'fastest_shipping', offer: offers?.fastestShipping },
    { key: 'highestRating', label: 'highest_rating', offer: offers?.highestRating },
  ].filter((entry) => entry.offer);

  const results = await Promise.all(
    entries.map(async ({ key, label, offer }) => {
      try {
        const summary = await summarizeReviews({
          productName: offer.title || productName,
          reviews: offer.reviewSnippets || [],
          supplier: offer.supplierLabel || offer.supplier,
          offerType: label,
        });

        return [key, { success: true, ...summary }];
      } catch (error) {
        return [
          key,
          {
            success: false,
            error: error.message,
            summary: '',
            pros: [],
            cons: [],
            sentiment: 'mixed',
            recommendation: '',
            reviewsArabic: [],
          },
        ];
      }
    })
  );

  return Object.fromEntries(results);
}

module.exports = {
  summarizeReviews,
  summarizeOffersInArabic,
};
