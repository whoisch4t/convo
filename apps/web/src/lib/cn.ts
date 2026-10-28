import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Joins class names; later Tailwind classes win over earlier conflicting ones (e.g. w-full then w-44). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
