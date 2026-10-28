'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '@convo/shared';
import { api, ApiError } from '@/lib/api';
import { Button, Card, Field, FormError, Input } from './ui';
import { IconLogo } from './icons';

/** Only allow redirects to paths inside this app. */
function safeNext(value: string | null) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/workspaces';
}

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  const isRegister = mode === 'register';

  const form = useForm<RegisterInput>({
    resolver: zodResolver((isRegister ? registerSchema : loginSchema) as typeof registerSchema),
    defaultValues: { name: '', email: '', password: '' },
  });
  const { errors, isSubmitting } = form.formState;

  async function submit(values: RegisterInput | LoginInput) {
    setFormError(null);
    try {
      await api(isRegister ? '/auth/register' : '/auth/login', { method: 'POST', body: values });
      router.replace(safeNext(params.get('next')));
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        for (const [path, message] of Object.entries(err.fieldErrors)) {
          form.setError(path as keyof RegisterInput, { message });
        }
        setFormError(err.details.length ? null : err.message);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    }
  }

  async function signInDemo() {
    await submit({ email: 'demo@whoischat.dev', password: 'demo1234' });
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <IconLogo />
            <span className="text-lg font-semibold">Convo</span>
          </Link>
        </div>
        <Card className="p-6">
          <h1 className="mb-5 text-xl font-semibold">{isRegister ? 'Create your account' : 'Sign in to Convo'}</h1>
          <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4" noValidate>
            <FormError message={formError} />
            {isRegister && (
              <Field label="Name" error={errors.name?.message}>
                {(p) => <Input {...p} autoComplete="name" {...form.register('name')} />}
              </Field>
            )}
            <Field label="Email" error={errors.email?.message}>
              {(p) => <Input {...p} type="email" autoComplete="email" {...form.register('email')} />}
            </Field>
            <Field
              label="Password"
              error={errors.password?.message}
              hint={isRegister ? 'At least 8 characters' : undefined}
            >
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  {...form.register('password')}
                />
              )}
            </Field>
            <Button type="submit" loading={isSubmitting} className="mt-1">
              {isRegister ? 'Create account' : 'Sign in'}
            </Button>
            {!isRegister && (
              <Button variant="secondary" onClick={signInDemo} disabled={isSubmitting}>
                Try the demo account
              </Button>
            )}
          </form>
        </Card>
        <p className="mt-5 text-center text-sm text-muted">
          {isRegister ? 'Already have an account?' : 'New to Convo?'}{' '}
          <Link href={isRegister ? '/login' : '/register'} className="font-medium text-primary hover:underline">
            {isRegister ? 'Sign in' : 'Create an account'}
          </Link>
        </p>
      </div>
    </div>
  );
}
