import React from 'react';

export default function BrandMark({ alt = 'QZZ' }) {
  return <img className="brand-mark" src="/qzz-logo.png" alt={alt} width="36" height="36" />;
}
