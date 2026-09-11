// Product IDs normally match Apple shop slugs; grouped models can share a page.
export function productSlug(model, product = {}) {
  const slug = product.appleSlug ?? (model === 'iphone-18-pro-max' ? 'iphone-18-pro' : model);
  if (typeof slug !== 'string' || !/^iphone-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error('Invalid Apple product page slug');
  }
  return slug;
}
export function catalogPages(products) {
  return Object.entries(products).reduce((pages, [model, product]) => {
    const slug = productSlug(model, product);
    return pages.some(page => page.slug === slug)
      ? pages.map(page => page.slug === slug ? {...page, models: [...page.models, model]} : page)
      : [...pages, {slug, models: [model]}];
  }, []);
}
