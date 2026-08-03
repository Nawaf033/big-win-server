const visualSearch = require('../services/visualSearch');
const reviewSummarizer = require('../services/reviewSummarizer');

function shapeOffer(offer, type) {
  if (!offer) return null;

  return {
    type,
    id: offer.id,
    title: offer.title,
    link: offer.link,
    thumbnail: offer.thumbnail,
    supplier: offer.supplier,
    supplierLabel: offer.supplierLabel,
    source: offer.source,
    price: offer.price,
    shippingCost: offer.shippingCost,
    totalPrice: offer.totalPrice,
    currency: offer.currency,
    shippingDays: offer.shippingDays,
    rating: offer.rating,
    inStock: offer.inStock,
  };
}

async function searchImage(req, res, next) {
  try {
    const { imageUrl, imageBase64 } = req.body;

    if (!imageUrl && !imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'Request body must include imageUrl or imageBase64',
      });
    }

    const searchResults = await visualSearch.searchByImage({ imageUrl, imageBase64 });

    if (!searchResults.selectedOffers.length) {
      return res.status(404).json({
        success: false,
        error:
          'No matching products found on AliExpress, 1688, Amazon, Trendyol, or Noon',
        data: {
          productName: searchResults.productName,
          query: searchResults.query,
          supplierOfferCount: searchResults.supplierOfferCount,
          rawResultCount: searchResults.rawResultCount,
        },
      });
    }

    const reviewSummaries = await reviewSummarizer.summarizeOffersInArabic({
      productName: searchResults.productName,
      offers: searchResults.offers,
    });

    const offers = {
      lowestPrice: shapeOffer(searchResults.offers.lowestPrice, 'lowest_price'),
      fastestShipping: shapeOffer(searchResults.offers.fastestShipping, 'fastest_shipping'),
      highestRating: shapeOffer(searchResults.offers.highestRating, 'highest_rating'),
    };

    return res.status(200).json({
      success: true,
      data: {
        productName: searchResults.productName,
        query: searchResults.query,
        supplierOfferCount: searchResults.supplierOfferCount,
        offers,
        reviewSummaries,
      },
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  searchImage,
};
