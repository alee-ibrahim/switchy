import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { NdiSource } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Combobox (shadcn Popover + Command recipe) over discovered NDI sources; typed names are allowed too. */
export function NdiSourcePicker({
  value,
  onChange,
  sources,
  placeholder = 'Pick an NDI source',
  id,
}: {
  value: string
  onChange: (v: string) => void
  sources: NdiSource[]
  placeholder?: string
  id?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const known = sources.some((s) => s.name === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button id={id} variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value || placeholder}
            {value && !known && <span className="text-muted-foreground"> (not discovered)</span>}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) p-0" align="start">
        <Command>
          <CommandInput placeholder="Search or type a source name..." value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No discovered source matches.</CommandEmpty>
            {search && !sources.some((s) => s.name === search) && (
              <CommandGroup heading="Use typed name">
                <CommandItem
                  value={`typed:${search}`}
                  onSelect={() => {
                    onChange(search)
                    setOpen(false)
                  }}
                >
                  {search}
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Discovered">
              {sources.map((s) => (
                <CommandItem
                  key={s.name}
                  value={s.name}
                  onSelect={() => {
                    onChange(s.name)
                    setOpen(false)
                  }}
                >
                  <Check className={cn(value === s.name ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{s.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{s.url}</span>
                </CommandItem>
              ))}
            </CommandGroup>
            {value && (
              <CommandGroup>
                <CommandItem
                  value="__clear__"
                  onSelect={() => {
                    onChange('')
                    setOpen(false)
                  }}
                >
                  Clear
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
