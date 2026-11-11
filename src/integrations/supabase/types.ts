export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      automation_runs: {
        Row: {
          finished_at: string | null
          id: string
          started_at: string
          status: string
          task_id: string
          user_id: string
        }
        Insert: {
          finished_at?: string | null
          id?: string
          started_at?: string
          status?: string
          task_id: string
          user_id: string
        }
        Update: {
          finished_at?: string | null
          id?: string
          started_at?: string
          status?: string
          task_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_runs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "automation_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_tasks: {
        Row: {
          created_at: string
          description: string | null
          id: string
          name: string
          script_content: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          name: string
          script_content: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          script_content?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      commands: {
        Row: {
          command: string
          completed_at: string | null
          created_at: string
          exit_code: number | null
          id: string
          server_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["command_status"]
          stderr: string | null
          stdout: string | null
          user_id: string
        }
        Insert: {
          command: string
          completed_at?: string | null
          created_at?: string
          exit_code?: number | null
          id?: string
          server_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["command_status"]
          stderr?: string | null
          stdout?: string | null
          user_id: string
        }
        Update: {
          command?: string
          completed_at?: string | null
          created_at?: string
          exit_code?: number | null
          id?: string
          server_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["command_status"]
          stderr?: string | null
          stdout?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "commands_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      cost_metrics: {
        Row: {
          created_at: string
          currency: string
          daily_cost: number
          day: string
          id: string
          server_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          currency?: string
          daily_cost?: number
          day: string
          id?: string
          server_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          currency?: string
          daily_cost?: number
          day?: string
          id?: string
          server_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "cost_metrics_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      metrics: {
        Row: {
          cpu_percent: number | null
          disk_percent: number | null
          disk_total_gb: number | null
          disk_used_gb: number | null
          id: number
          load_1: number | null
          memory_percent: number | null
          memory_total_mb: number | null
          memory_used_mb: number | null
          net_rx_kbs: number | null
          net_tx_kbs: number | null
          recorded_at: string
          server_id: string
          uptime_seconds: number | null
        }
        Insert: {
          cpu_percent?: number | null
          disk_percent?: number | null
          disk_total_gb?: number | null
          disk_used_gb?: number | null
          id?: number
          load_1?: number | null
          memory_percent?: number | null
          memory_total_mb?: number | null
          memory_used_mb?: number | null
          net_rx_kbs?: number | null
          net_tx_kbs?: number | null
          recorded_at?: string
          server_id: string
          uptime_seconds?: number | null
        }
        Update: {
          cpu_percent?: number | null
          disk_percent?: number | null
          disk_total_gb?: number | null
          disk_used_gb?: number | null
          id?: number
          load_1?: number | null
          memory_percent?: number | null
          memory_total_mb?: number | null
          memory_used_mb?: number | null
          net_rx_kbs?: number | null
          net_tx_kbs?: number | null
          recorded_at?: string
          server_id?: string
          uptime_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "metrics_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      servers: {
        Row: {
          agent_token_hash: string
          connection_notes: string | null
          created_at: string
          hostname: string | null
          id: string
          instance_id: string | null
          ip_address: string | null
          last_seen_at: string | null
          name: string
          os: string | null
          region: string | null
          tags: string[]
          type: string
          user_id: string
        }
        Insert: {
          agent_token_hash: string
          connection_notes?: string | null
          created_at?: string
          hostname?: string | null
          id?: string
          instance_id?: string | null
          ip_address?: string | null
          last_seen_at?: string | null
          name: string
          os?: string | null
          region?: string | null
          tags?: string[]
          type?: string
          user_id: string
        }
        Update: {
          agent_token_hash?: string
          connection_notes?: string | null
          created_at?: string
          hostname?: string | null
          id?: string
          instance_id?: string | null
          ip_address?: string | null
          last_seen_at?: string | null
          name?: string
          os?: string | null
          region?: string | null
          tags?: string[]
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      task_logs: {
        Row: {
          command_id: string | null
          created_at: string
          id: string
          output_log: string | null
          run_id: string
          server_id: string
          status: string
          user_id: string
        }
        Insert: {
          command_id?: string | null
          created_at?: string
          id?: string
          output_log?: string | null
          run_id: string
          server_id: string
          status?: string
          user_id: string
        }
        Update: {
          command_id?: string | null
          created_at?: string
          id?: string
          output_log?: string | null
          run_id?: string
          server_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_logs_command_id_fkey"
            columns: ["command_id"]
            isOneToOne: false
            referencedRelation: "commands"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_logs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "automation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_logs_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
      terminal_sessions: {
        Row: {
          agent_input_ack: number
          client_output_ack: number
          closed_at: string | null
          cols: number
          created_at: string
          id: string
          input_buffer: string
          input_seq: number
          last_agent_poll_at: string | null
          last_client_poll_at: string
          output_buffer: string
          output_seq: number
          rows: number
          server_id: string
          status: Database["public"]["Enums"]["terminal_session_status"]
          user_id: string
        }
        Insert: {
          agent_input_ack?: number
          client_output_ack?: number
          closed_at?: string | null
          cols?: number
          created_at?: string
          id?: string
          input_buffer?: string
          input_seq?: number
          last_agent_poll_at?: string | null
          last_client_poll_at?: string
          output_buffer?: string
          output_seq?: number
          rows?: number
          server_id: string
          status?: Database["public"]["Enums"]["terminal_session_status"]
          user_id: string
        }
        Update: {
          agent_input_ack?: number
          client_output_ack?: number
          closed_at?: string | null
          cols?: number
          created_at?: string
          id?: string
          input_buffer?: string
          input_seq?: number
          last_agent_poll_at?: string | null
          last_client_poll_at?: string
          output_buffer?: string
          output_seq?: number
          rows?: number
          server_id?: string
          status?: Database["public"]["Enums"]["terminal_session_status"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "terminal_sessions_server_id_fkey"
            columns: ["server_id"]
            isOneToOne: false
            referencedRelation: "servers"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      command_status: "pending" | "running" | "completed" | "failed"
      terminal_session_status: "requested" | "active" | "closed"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      command_status: ["pending", "running", "completed", "failed"],
      terminal_session_status: ["requested", "active", "closed"],
    },
  },
} as const
