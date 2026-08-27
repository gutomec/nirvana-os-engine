"use client";

import { BarChart3, Box, Bot, Building2, CreditCard, FileText, Globe, KeyRound, Lock, Mail, Network, Search, Workflow } from "lucide-react";

const ICONS = {
  Search,
  BarChart3,
  Globe,
  Mail,
  CreditCard,
  KeyRound,
  Workflow,
  Bot,
  FileText,
  Box,
  Lock,
  squad: Network,
  business: Building2,
} as const;

export function EntityIcon({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? Box;
  return <Icon className={className} aria-hidden />;
}
