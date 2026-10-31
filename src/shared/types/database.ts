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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      admission_counters: {
        Row: {
          last_value: number
          scope: string
        }
        Insert: {
          last_value?: number
          scope: string
        }
        Update: {
          last_value?: number
          scope?: string
        }
        Relationships: []
      }
      admission_papers: {
        Row: {
          course_ids: string[] | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          is_required: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          course_ids?: string[] | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_required?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          course_ids?: string[] | null
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          is_required?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      app_nudges: {
        Row: {
          created_at: string
          done_at: string | null
          id: string
          kind: string
          message: string | null
          reason: string | null
          seen_at: string | null
          sent_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          done_at?: string | null
          id?: string
          kind?: string
          message?: string | null
          reason?: string | null
          seen_at?: string | null
          sent_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          done_at?: string | null
          id?: string
          kind?: string
          message?: string | null
          reason?: string | null
          seen_at?: string | null
          sent_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_nudges_sent_by_fkey"
            columns: ["sent_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_nudges_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      fee_installments: {
        Row: {
          amount: number
          course_id: string | null
          created_at: string
          created_by: string | null
          due_date: string
          id: string
          lead_id: string
          seq: number
        }
        Insert: {
          amount: number
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          due_date: string
          id?: string
          lead_id: string
          seq: number
        }
        Update: {
          amount?: number
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          due_date?: string
          id?: string
          lead_id?: string
          seq?: number
        }
        Relationships: []
      }
      fee_payments: {
        Row: {
          amount: number
          course_id: string | null
          created_at: string
          id: string
          lead_id: string
          method: string
          note: string | null
          paid_at: string
          receipt_no: string
          kind: string
          received_by: string | null
          txn_id: string | null
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount: number
          course_id?: string | null
          created_at?: string
          id?: string
          lead_id: string
          method: string
          note?: string | null
          paid_at?: string
          receipt_no: string
          kind?: string
          received_by?: string | null
          txn_id?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount?: number
          course_id?: string | null
          created_at?: string
          id?: string
          lead_id?: string
          method?: string
          note?: string | null
          paid_at?: string
          receipt_no?: string
          kind?: string
          received_by?: string | null
          txn_id?: string | null
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: []
      }
      fee_discounts: {
        Row: {
          amount: number
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          expires_at: string | null
          fee_id: string | null
          fee_name: string | null
          id: string
          kind: string
          lead_id: string
          negotiation_id: string
          note: string | null
          reason: string | null
          requested_at: string
          requested_by: string | null
          status: string
          value: number
        }
        Insert: {
          amount: number
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          expires_at?: string | null
          fee_id?: string | null
          fee_name?: string | null
          id?: string
          kind: string
          lead_id: string
          negotiation_id: string
          note?: string | null
          reason?: string | null
          requested_at?: string
          requested_by?: string | null
          status?: string
          value: number
        }
        Update: {
          amount?: number
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          expires_at?: string | null
          fee_id?: string | null
          fee_name?: string | null
          id?: string
          kind?: string
          lead_id?: string
          negotiation_id?: string
          note?: string | null
          reason?: string | null
          requested_at?: string
          requested_by?: string | null
          status?: string
          value?: number
        }
        Relationships: []
      }
      lead_files: {
        Row: {
          call_id: string | null
          context: string | null
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          drive_file_id: string
          duration_sec: number | null
          id: string
          kind: string
          lead_id: string
          mime_type: string | null
          name: string
          paper_id: string | null
          size_bytes: number | null
          uploaded_by: string | null
        }
        Insert: {
          call_id?: string | null
          context?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          drive_file_id: string
          duration_sec?: number | null
          id?: string
          kind: string
          lead_id: string
          mime_type?: string | null
          name: string
          paper_id?: string | null
          size_bytes?: number | null
          uploaded_by?: string | null
        }
        Update: {
          call_id?: string | null
          context?: string | null
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          drive_file_id?: string
          duration_sec?: number | null
          id?: string
          kind?: string
          lead_id?: string
          mime_type?: string | null
          name?: string
          paper_id?: string | null
          size_bytes?: number | null
          uploaded_by?: string | null
        }
        Relationships: []
      }
      lead_negotiations: {
        Row: {
          course_id: string
          final_total: number | null
          id: string
          lead_id: string
          locked_at: string | null
          started_at: string
          started_by: string | null
          status: string
        }
        Insert: {
          course_id: string
          final_total?: number | null
          id?: string
          lead_id: string
          locked_at?: string | null
          started_at?: string
          started_by?: string | null
          status?: string
        }
        Update: {
          course_id?: string
          final_total?: number | null
          id?: string
          lead_id?: string
          locked_at?: string | null
          started_at?: string
          started_by?: string | null
          status?: string
        }
        Relationships: []
      }
      message_templates: {
        Row: {
          body: string
          category: string | null
          channels: string
          course_ids: string[] | null
          created_at: string
          id: string
          is_active: boolean
          is_shared: boolean
          last_used_at: string | null
          name: string
          owner_id: string | null
          sort_order: number
          updated_at: string
          use_count: number
        }
        Insert: {
          body: string
          category?: string | null
          channels?: string
          course_ids?: string[] | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_shared?: boolean
          last_used_at?: string | null
          name: string
          owner_id?: string | null
          sort_order?: number
          updated_at?: string
          use_count?: number
        }
        Update: {
          body?: string
          category?: string | null
          channels?: string
          course_ids?: string[] | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_shared?: boolean
          last_used_at?: string | null
          name?: string
          owner_id?: string | null
          sort_order?: number
          updated_at?: string
          use_count?: number
        }
        Relationships: []
      }
      notification_prefs: {
        Row: { muted: string[]; user_id: string }
        Insert: { muted?: string[]; user_id: string }
        Update: { muted?: string[]; user_id?: string }
        Relationships: []
      }
      negotiation_events: {
        Row: {
          amount: number | null
          created_at: string
          created_by: string | null
          id: string
          kind: string
          lead_id: string
          negotiation_id: string
          note: string | null
        }
        Insert: {
          amount?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind: string
          lead_id: string
          negotiation_id: string
          note?: string | null
        }
        Update: {
          amount?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          kind?: string
          lead_id?: string
          negotiation_id?: string
          note?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          data: Json
          dedupe: string | null
          deliver_after: string
          id: string
          kind: string
          push_status: string | null
          read_at: string | null
          sent_at: string | null
          title: string
          user_id: string
        }
        Insert: {
          body?: string | null
          created_at?: string
          data?: Json
          dedupe?: string | null
          deliver_after?: string
          id?: string
          kind: string
          push_status?: string | null
          read_at?: string | null
          sent_at?: string | null
          title: string
          user_id: string
        }
        Update: {
          body?: string | null
          created_at?: string
          data?: Json
          dedupe?: string | null
          deliver_after?: string
          id?: string
          kind?: string
          push_status?: string | null
          read_at?: string | null
          sent_at?: string | null
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      app_sessions: {
        Row: {
          active_sec: number
          app_version: string | null
          device_id: string | null
          device_label: string | null
          ended: boolean
          id: string
          last_seen_at: string
          started_at: string
          user_id: string
        }
        Insert: {
          active_sec?: number
          app_version?: string | null
          device_id?: string | null
          device_label?: string | null
          ended?: boolean
          id: string
          last_seen_at: string
          started_at: string
          user_id: string
        }
        Update: {
          active_sec?: number
          app_version?: string | null
          device_id?: string | null
          device_label?: string | null
          ended?: boolean
          id?: string
          last_seen_at?: string
          started_at?: string
          user_id?: string
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          created_at: string
          description: string | null
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          created_at?: string
          description?: string | null
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          created_at?: string
          description?: string | null
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      batches: {
        Row: {
          class_time: string | null
          course_id: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          name: string
          seat_capacity: number | null
          sort_order: number
          start_date: string | null
          status: string
          updated_at: string
        }
        Insert: {
          class_time?: string | null
          course_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name: string
          seat_capacity?: number | null
          sort_order?: number
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          class_time?: string | null
          course_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          seat_capacity?: number | null
          sort_order?: number
          start_date?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "batches_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      call_logs: {
        Row: {
          called_at: string
          channel: string
          created_at: string
          device_call_id: string | null
          device_id: string | null
          direction: string
          duration_sec: number | null
          id: string
          lead_id: string
          media: string | null
          notes: string | null
          outcome: string
          phone_verified: boolean | null
          sim_label: string | null
          source: string
          user_id: string
        }
        Insert: {
          called_at?: string
          channel?: string
          created_at?: string
          device_call_id?: string | null
          device_id?: string | null
          direction?: string
          duration_sec?: number | null
          id?: string
          lead_id: string
          media?: string | null
          notes?: string | null
          outcome: string
          phone_verified?: boolean | null
          sim_label?: string | null
          source?: string
          user_id?: string
        }
        Update: {
          called_at?: string
          channel?: string
          created_at?: string
          device_call_id?: string | null
          device_id?: string | null
          direction?: string
          duration_sec?: number | null
          id?: string
          lead_id?: string
          media?: string | null
          notes?: string | null
          outcome?: string
          phone_verified?: boolean | null
          sim_label?: string | null
          source?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_logs_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      call_results: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          is_connected: boolean
          key: string
          name: string
          requires_note: boolean
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_connected?: boolean
          key: string
          name: string
          requires_note?: boolean
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          is_connected?: boolean
          key?: string
          name?: string
          requires_note?: boolean
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      call_sync_devices: {
        Row: {
          app_version: string | null
          device_id: string
          device_label: string | null
          last_error: string | null
          last_sync_at: string | null
          pending_count: number | null
          permission_ok: boolean | null
          sim_label: string | null
          sync_on: boolean | null
          updated_at: string
          user_id: string
        }
        Insert: {
          app_version?: string | null
          device_id: string
          device_label?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          pending_count?: number | null
          permission_ok?: boolean | null
          sim_label?: string | null
          sync_on?: boolean | null
          updated_at?: string
          user_id?: string
        }
        Update: {
          app_version?: string | null
          device_id?: string
          device_label?: string | null
          last_error?: string | null
          last_sync_at?: string | null
          pending_count?: number | null
          permission_ok?: boolean | null
          sim_label?: string | null
          sync_on?: boolean | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_sync_devices_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      campaigns: {
        Row: {
          cost: number | null
          created_at: string
          created_by: string | null
          end_date: string | null
          id: string
          is_active: boolean
          name: string
          sort_order: number
          source_id: string | null
          start_date: string | null
          updated_at: string
        }
        Insert: {
          cost?: number | null
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          source_id?: string | null
          start_date?: string | null
          updated_at?: string
        }
        Update: {
          cost?: number | null
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          source_id?: string | null
          start_date?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "lead_sources"
            referencedColumns: ["id"]
          },
        ]
      }
      course_fees: {
        Row: {
          amount: number
          course_id: string
          created_at: string
          id: string
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          amount: number
          course_id: string
          created_at?: string
          id?: string
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          amount?: number
          course_id?: string
          created_at?: string
          id?: string
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "course_fees_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      courses: {
        Row: {
          category: string | null
          created_at: string
          created_by: string | null
          description: string | null
          duration: string | null
          id: string
          is_active: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          duration?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          category?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          duration?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      document_types: {
        Row: {
          course_id: string | null
          created_at: string
          id: string
          is_active: boolean
          is_required: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          course_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_required?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          course_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          is_required?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_types_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      export_logs: {
        Row: {
          created_at: string
          filters: Json
          id: string
          row_count: number
          user_id: string
        }
        Insert: {
          created_at?: string
          filters?: Json
          id?: string
          row_count: number
          user_id: string
        }
        Update: {
          created_at?: string
          filters?: Json
          id?: string
          row_count?: number
          user_id?: string
        }
        Relationships: []
      }
      feature_flags: {
        Row: {
          created_at: string
          description: string | null
          is_enabled: boolean
          key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          is_enabled?: boolean
          key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          is_enabled?: boolean
          key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      follow_ups: {
        Row: {
          call_id: string | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string
          due_at: string
          id: string
          lead_id: string
          note: string | null
          purpose: string | null
          status: string
        }
        Insert: {
          call_id?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          due_at: string
          id?: string
          lead_id: string
          note?: string | null
          purpose?: string | null
          status?: string
        }
        Update: {
          call_id?: string | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          due_at?: string
          id?: string
          lead_id?: string
          note?: string | null
          purpose?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "follow_ups_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "call_logs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "follow_ups_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      holidays: {
        Row: {
          created_at: string
          created_by: string | null
          end_date: string
          id: string
          is_active: boolean
          name: string
          start_date: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          end_date: string
          id?: string
          is_active?: boolean
          name: string
          start_date: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          end_date?: string
          id?: string
          is_active?: boolean
          name?: string
          start_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      import_batches: {
        Row: {
          created: number
          created_at: string
          created_by: string | null
          failed: number
          file_name: string | null
          id: string
          rr_index: number
          settings: Json
          skipped: number
          undone_at: string | null
          updated: number
        }
        Insert: {
          created?: number
          created_at?: string
          created_by?: string | null
          failed?: number
          file_name?: string | null
          id?: string
          rr_index?: number
          settings?: Json
          skipped?: number
          undone_at?: string | null
          updated?: number
        }
        Update: {
          created?: number
          created_at?: string
          created_by?: string | null
          failed?: number
          file_name?: string | null
          id?: string
          rr_index?: number
          settings?: Json
          skipped?: number
          undone_at?: string | null
          updated?: number
        }
        Relationships: []
      }
      lead_activity: {
        Row: {
          action: string
          created_at: string
          details: Json
          id: string
          lead_id: string
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json
          id?: string
          lead_id: string
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json
          id?: string
          lead_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_activity_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_courses: {
        Row: {
          course_id: string
          created_at: string
          lead_id: string
        }
        Insert: {
          course_id: string
          created_at?: string
          lead_id: string
        }
        Update: {
          course_id?: string
          created_at?: string
          lead_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_courses_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_courses_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_paper_folders: {
        Row: {
          kept_at: string
          lead_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          kept_at: string
          lead_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          kept_at?: string
          lead_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_paper_folders_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: true
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_paper_folders_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_papers: {
        Row: {
          copy_type: string | null
          id: string
          kept_at: string | null
          lead_id: string
          note: string | null
          paper_id: string
          received_at: string
          received_by: string | null
          returned_at: string | null
          returned_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          copy_type?: string | null
          id?: string
          kept_at?: string | null
          lead_id: string
          note?: string | null
          paper_id: string
          received_at?: string
          received_by?: string | null
          returned_at?: string | null
          returned_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          copy_type?: string | null
          id?: string
          kept_at?: string | null
          lead_id?: string
          note?: string | null
          paper_id?: string
          received_at?: string
          received_by?: string | null
          returned_at?: string | null
          returned_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_papers_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_papers_paper_id_fkey"
            columns: ["paper_id"]
            isOneToOne: false
            referencedRelation: "admission_papers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_papers_received_by_fkey"
            columns: ["received_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_papers_returned_by_fkey"
            columns: ["returned_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_sources: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      lead_stage_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          from_stage_id: string | null
          id: string
          lead_id: string
          note: string | null
          to_stage_id: string | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          from_stage_id?: string | null
          id?: string
          lead_id: string
          note?: string | null
          to_stage_id?: string | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          from_stage_id?: string | null
          id?: string
          lead_id?: string
          note?: string | null
          to_stage_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_stage_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_stage_history_from_stage_id_fkey"
            columns: ["from_stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_stage_history_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_stage_history_to_stage_id_fkey"
            columns: ["to_stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_tags: {
        Row: {
          created_at: string
          lead_id: string
          tag_id: string
        }
        Insert: {
          created_at?: string
          lead_id: string
          tag_id: string
        }
        Update: {
          created_at?: string
          lead_id?: string
          tag_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lead_tags_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_tags_tag_id_fkey"
            columns: ["tag_id"]
            isOneToOne: false
            referencedRelation: "tags"
            referencedColumns: ["id"]
          },
        ]
      }
      lead_types: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      lead_visits: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          lead_id: string
          note: string | null
          planned_at: string | null
          status: string
          updated_at: string
          updated_by: string | null
          visited_at: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          lead_id: string
          note?: string | null
          planned_at?: string | null
          status?: string
          updated_at?: string
          updated_by?: string | null
          visited_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          lead_id?: string
          note?: string | null
          planned_at?: string | null
          status?: string
          updated_at?: string
          updated_by?: string | null
          visited_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lead_visits_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_visits_lead_id_fkey"
            columns: ["lead_id"]
            isOneToOne: false
            referencedRelation: "leads"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lead_visits_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      leads: {
        Row: {
          admission_note: string | null
          admitted_at: string | null
          admitted_batch_id: string | null
          admitted_by: string | null
          admitted_course_id: string | null
          alt_phone: string | null
          area: string | null
          assigned_to: string | null
          assignment_method: string | null
          call_attempts: number
          campaign_id: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          closed_at: string | null
          created_at: string
          created_by: string | null
          custom_fields: Json
          deleted_at: string | null
          email: string | null
          guardian_name: string | null
          guardian_phone: string | null
          guardian_relation: string | null
          id: string
          import_batch_id: string | null
          last_contacted_at: string | null
          lead_type_id: string | null
          lost_at: string | null
          lost_by: string | null
          lost_note: string | null
          lost_reason_id: string | null
          name: string
          next_follow_up_at: string | null
          notes: string | null
          papers_kept_at: string | null
          papers_missing: number | null
          papers_originals_held: number
          papers_received: number
          papers_required: number
          phone: string | null
          rating: string | null
          referred_by: string | null
          score: number
          source_id: string | null
          stage_id: string
          student_ref: string | null
          unreachable_at: string | null
          updated_at: string
          visit_at: string | null
          visit_status: string | null
          fee_status: string | null
          fee_paid: number | null
          fee_due: number | null
          fee_next_due: string | null
          fee_full: number | null
          fee_discount: number | null
          fee_final: number | null
          fee_updated_at: string | null
          whatsapp_number: string | null
          whatsapp_username: string | null
        }
        Insert: {
          admission_note?: string | null
          admitted_at?: string | null
          admitted_batch_id?: string | null
          admitted_by?: string | null
          admitted_course_id?: string | null
          alt_phone?: string | null
          area?: string | null
          assigned_to?: string | null
          assignment_method?: string | null
          call_attempts?: number
          campaign_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          custom_fields?: Json
          deleted_at?: string | null
          email?: string | null
          guardian_name?: string | null
          guardian_phone?: string | null
          guardian_relation?: string | null
          id?: string
          import_batch_id?: string | null
          last_contacted_at?: string | null
          lead_type_id?: string | null
          lost_at?: string | null
          lost_by?: string | null
          lost_note?: string | null
          lost_reason_id?: string | null
          name: string
          next_follow_up_at?: string | null
          notes?: string | null
          papers_kept_at?: string | null
          papers_missing?: number | null
          papers_originals_held?: number
          papers_received?: number
          papers_required?: number
          phone?: string | null
          rating?: string | null
          referred_by?: string | null
          score?: number
          source_id?: string | null
          stage_id: string
          student_ref?: string | null
          unreachable_at?: string | null
          updated_at?: string
          visit_at?: string | null
          visit_status?: string | null
          fee_status?: string | null
          fee_paid?: number | null
          fee_due?: number | null
          fee_next_due?: string | null
          fee_full?: number | null
          fee_discount?: number | null
          fee_final?: number | null
          fee_updated_at?: string | null
          whatsapp_number?: string | null
          whatsapp_username?: string | null
        }
        Update: {
          admission_note?: string | null
          admitted_at?: string | null
          admitted_batch_id?: string | null
          admitted_by?: string | null
          admitted_course_id?: string | null
          alt_phone?: string | null
          area?: string | null
          assigned_to?: string | null
          assignment_method?: string | null
          call_attempts?: number
          campaign_id?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          closed_at?: string | null
          created_at?: string
          created_by?: string | null
          custom_fields?: Json
          deleted_at?: string | null
          email?: string | null
          guardian_name?: string | null
          guardian_phone?: string | null
          guardian_relation?: string | null
          id?: string
          import_batch_id?: string | null
          last_contacted_at?: string | null
          lead_type_id?: string | null
          lost_at?: string | null
          lost_by?: string | null
          lost_note?: string | null
          lost_reason_id?: string | null
          name?: string
          next_follow_up_at?: string | null
          notes?: string | null
          papers_kept_at?: string | null
          papers_missing?: number | null
          papers_originals_held?: number
          papers_received?: number
          papers_required?: number
          phone?: string | null
          rating?: string | null
          referred_by?: string | null
          score?: number
          source_id?: string | null
          stage_id?: string
          student_ref?: string | null
          unreachable_at?: string | null
          updated_at?: string
          visit_at?: string | null
          visit_status?: string | null
          fee_status?: string | null
          fee_paid?: number | null
          fee_due?: number | null
          fee_next_due?: string | null
          fee_full?: number | null
          fee_discount?: number | null
          fee_final?: number | null
          fee_updated_at?: string | null
          whatsapp_number?: string | null
          whatsapp_username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "leads_admitted_batch_id_fkey"
            columns: ["admitted_batch_id"]
            isOneToOne: false
            referencedRelation: "batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_admitted_by_fkey"
            columns: ["admitted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_admitted_course_id_fkey"
            columns: ["admitted_course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_import_batch_id_fkey"
            columns: ["import_batch_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_lead_type_id_fkey"
            columns: ["lead_type_id"]
            isOneToOne: false
            referencedRelation: "lead_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_lost_by_fkey"
            columns: ["lost_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_lost_reason_id_fkey"
            columns: ["lost_reason_id"]
            isOneToOne: false
            referencedRelation: "lost_reasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "lead_sources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leads_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "pipeline_stages"
            referencedColumns: ["id"]
          },
        ]
      }
      lost_reasons: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      pipeline_stages: {
        Row: {
          ask_date: boolean
          color: string
          created_at: string
          date_label: string | null
          follow_up_days: number | null
          id: string
          is_active: boolean
          is_system: boolean
          key: string
          kind: string
          name: string
          note_required: boolean
          sort_order: number
          updated_at: string
        }
        Insert: {
          ask_date?: boolean
          color?: string
          created_at?: string
          date_label?: string | null
          follow_up_days?: number | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          key: string
          kind?: string
          name: string
          note_required?: boolean
          sort_order?: number
          updated_at?: string
        }
        Update: {
          ask_date?: boolean
          color?: string
          created_at?: string
          date_label?: string | null
          follow_up_days?: number | null
          id?: string
          is_active?: boolean
          is_system?: boolean
          key?: string
          kind?: string
          name?: string
          note_required?: boolean
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          deactivated_at: string | null
          email: string | null
          full_name: string | null
          id: string
          is_active: boolean
          must_change_password: boolean
          phone: string | null
          role_key: string
          team_lead_id: string | null
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          deactivated_at?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          is_active?: boolean
          must_change_password?: boolean
          phone?: string | null
          role_key?: string
          team_lead_id?: string | null
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          deactivated_at?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          must_change_password?: boolean
          phone?: string | null
          role_key?: string
          team_lead_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_role_key_fkey"
            columns: ["role_key"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["key"]
          },
          {
            foreignKeyName: "profiles_team_lead_id_fkey"
            columns: ["team_lead_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          description: string | null
          is_system: boolean
          key: string
          name: string
          permissions: string[]
          rank: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          is_system?: boolean
          key: string
          name: string
          permissions?: string[]
          rank: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          is_system?: boolean
          key?: string
          name?: string
          permissions?: string[]
          rank?: number
          updated_at?: string
        }
        Relationships: []
      }
      saved_filters: {
        Row: {
          created_at: string
          filters: Json
          id: string
          is_shared: boolean
          name: string
          owner_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          filters?: Json
          id?: string
          is_shared?: boolean
          name: string
          owner_id?: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          filters?: Json
          id?: string
          is_shared?: boolean
          name?: string
          owner_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_filters_owner_id_fkey"
            columns: ["owner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tags: {
        Row: {
          color: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          color?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          color?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admission_batches: {
        Args: { p_course_id: string }
        Returns: {
          class_time: string
          id: string
          is_full: boolean
          name: string
          seat_capacity: number
          seats_left: number
          seats_taken: number
          start_date: string
          status: string
        }[]
      }
      activity_counts: {
        Args: { p_from: string; p_search?: string; p_to: string; p_user_id?: string }
        Returns: { action: string; n: number }[]
      }
      activity_feed: {
        Args: {
          p_actions?: string[]
          p_before?: string
          p_from: string
          p_limit?: number
          p_search?: string
          p_to: string
          p_user_id?: string
        }
        Returns: {
          action: string
          created_at: string
          details: Json
          id: string
          lead_id: string
          lead_name: string
          lead_phone: string
          user_id: string
          user_name: string | null
        }[]
      }
      activity_setting: { Args: never; Returns: Json }
      add_lead_note: {
        Args: { p_lead_ids: string[]; p_note: string }
        Returns: number
      }
      admission_rule_allows: { Args: { p_rule: Json }; Returns: boolean }
      admission_setting: { Args: never; Returns: Json }
      assignment_setting: { Args: never; Returns: Json }
      batch_seats_taken: { Args: { p_batch_id: string }; Returns: number }
      bulk_move_lead_stage: {
        Args: {
          p_due_at?: string
          p_lead_ids: string[]
          p_note?: string
          p_stage_id: string
        }
        Returns: Json
      }
      bulk_mark_lost: {
        Args: { p_lead_ids: string[]; p_note?: string; p_reason_id: string }
        Returns: Json
      }
      call_heatmap: {
        Args: { p_from: string; p_to: string; p_user_id?: string }
        Returns: {
          attempts: number
          connected: number
          dow: number
          hour: number
        }[]
      }
      call_report: {
        Args: { p_from: string; p_to: string; p_user_id?: string }
        Returns: {
          avg_talk_sec: number
          calls: number
          connected: number
          day: string
          first_call: string
          last_call: string
          missed: number
          outgoing: number
          short_connected: number
          talk_sec: number
          user_id: string
          user_name: string
        }[]
      }
      call_sync_health: {
        Args: never
        Returns: {
          allowed: boolean
          app_version: string
          device_id: string
          device_label: string
          last_error: string
          last_phone_call_at: string
          last_sync_at: string
          nudge_at: string
          nudge_open: boolean
          nudge_seen_at: string
          pending_count: number
          permission_ok: boolean
          phone_calls_today: number
          role_key: string
          sim_label: string
          sync_on: boolean
          team_lead_id: string
          updated_at: string
          wa_access: boolean | null
          wa_on: boolean | null
          wa_today: number
          user_id: string
          user_name: string
        }[]
      }
      call_sync_setting: { Args: never; Returns: Json }
      campus_visit_setting: { Args: never; Returns: Json }
      can_assign_to: { Args: { p_target: string }; Returns: boolean }
      can_cancel_admission: { Args: never; Returns: boolean }
      can_edit_lead: { Args: { p_assigned_to: string }; Returns: boolean }
      can_import_contacts: { Args: never; Returns: boolean }
      can_mark_admitted: { Args: never; Returns: boolean }
      can_sync_calls: { Args: never; Returns: boolean }
      can_user_sync_calls: { Args: { p_user: string }; Returns: boolean }
      can_view_lead: { Args: { p_assigned_to: string }; Returns: boolean }
      cancel_admission: {
        Args: { p_lead_id: string; p_note?: string; p_reason: string }
        Returns: undefined
      }
      cancel_follow_up: { Args: { p_lead_id: string }; Returns: undefined }
      cancel_visit: { Args: { p_lead_id: string }; Returns: undefined }
      close_my_sync_nudges: { Args: never; Returns: undefined }
      complete_first_run_setup: {
        Args: { p_full_name: string; p_institution_name: string }
        Returns: undefined
      }
      current_role_key: { Args: never; Returns: string }
      existing_lead_phones: { Args: { p_phones: string[] }; Returns: string[] }
      delete_call_log: { Args: { p_call_id: string; p_reason?: string }; Returns: string }
      delete_call_note: { Args: { p_call_id: string; p_reason?: string }; Returns: string }
      delete_lead_note: { Args: { p_block: string; p_lead_id: string; p_reason?: string }; Returns: string }
      find_leads_by_contact: {
        Args: {
          p_exclude_id?: string
          p_phone?: string
          p_whatsapp_number?: string
          p_whatsapp_username?: string
        }
        Returns: {
          assigned_to_name: string
          can_open: boolean
          id: string
          matched: string
          name: string
          phone: string
          stage_name: string
        }[]
      }
      find_leads_by_phone: {
        Args: { p_exclude_id?: string; p_phone: string }
        Returns: {
          assigned_to_name: string
          can_open: boolean
          id: string
          name: string
          phone: string
          stage_name: string
        }[]
      }
      finish_visit: {
        Args: {
          p_lead_id: string
          p_note?: string
          p_status: string
          p_visited_at?: string
        }
        Returns: Json
      }
      finish_pending_follow_up: {
        Args: { p_lead_id: string }
        Returns: undefined
      }
      forget_sync_device: {
        Args: { p_device_id: string; p_user_id: string }
        Returns: undefined
      }
      format_student_ref: {
        Args: { p_number: number; p_pattern: string }
        Returns: string
      }
      has_permission: { Args: { perm: string }; Returns: boolean }
      import_leads: { Args: { p_options: Json; p_rows: Json }; Returns: Json }
      is_active_user: { Args: never; Returns: boolean }
      is_setup_complete: { Args: never; Returns: boolean }
      is_super_admin: { Args: never; Returns: boolean }
      hand_over_leads: {
        Args: { p_lead_ids: string[]; p_note?: string; p_to: string }
        Returns: Json
      }
      lead_report: {
        Args: { p_course_id?: string; p_from: string; p_to: string; p_user_id?: string }
        Returns: Json
      }
      lead_missing_papers: {
        Args: { p_course_id?: string; p_lead_id: string }
        Returns: {
          name: string
          paper_id: string
        }[]
      }
      lead_papers_status: {
        Args: { p_lead_id: string }
        Returns: {
          copy_type: string
          description: string
          is_required: boolean
          kept_at: string
          name: string
          note: string
          paper_id: string
          received_at: string
          received_by_name: string
          record_id: string
          returned_at: string
          returned_by_name: string
          status: string
        }[]
      }
      leads_shared_mode: { Args: never; Returns: boolean }
      mark_admitted: {
        Args: {
          p_admitted_at?: string
          p_batch_id?: string
          p_course_id: string
          p_lead_id: string
          p_note?: string
          p_student_ref?: string
        }
        Returns: Json
      }
      mark_lost: {
        Args: {
          p_lead_id: string
          p_note?: string
          p_reason_id: string
          p_revive_at?: string
        }
        Returns: undefined
      }
      mark_nudge_seen: { Args: { p_id: string }; Returns: undefined }
      mark_notifications_read: { Args: { p_ids?: string[] }; Returns: undefined }
      move_lead_stage: {
        Args: {
          p_due_at?: string
          p_lead_id: string
          p_note?: string
          p_stage_id: string
        }
        Returns: Json
      }
      my_lead_directory: {
        Args: never
        Returns: {
          course: string
          hash: string
          last_note: string
          lead_id: string
          name: string
          rating: string
          stage: string
        }[]
      }
      my_open_nudge: {
        Args: never
        Returns: {
          created_at: string
          id: string
          kind: string
          message: string
          reason: string
          seen_at: string
          sent_by_name: string
        }[]
      }
      next_student_ref: { Args: never; Returns: string }
      normalize_bd_phone: { Args: { p: string }; Returns: string }
      paper_place_suggestions: {
        Args: never
        Returns: {
          kept_at: string
        }[]
      }
      papers_for_lead: {
        Args: { p_course_id?: string; p_lead_id: string }
        Returns: {
          course_ids: string[] | null
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          is_required: boolean
          name: string
          sort_order: number
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "admission_papers"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      register_push_token: {
        Args: { p_device_id?: string; p_platform?: string; p_token: string }
        Returns: undefined
      }
      remove_push_token: { Args: { p_token: string }; Returns: undefined }
      report_app_session: {
        Args: {
          p_active_sec: number
          p_app_version?: string
          p_device_id?: string
          p_device_label?: string
          p_ended?: boolean
          p_id: string
          p_last_seen_at: string
          p_started_at: string
        }
        Returns: undefined
      }
      plan_visit: {
        Args: { p_at: string; p_lead_id: string; p_note?: string }
        Returns: string
      }
      preview_student_ref: { Args: never; Returns: string }
      refresh_lead_papers: { Args: { p_lead_id: string }; Returns: undefined }
      reopen_lead: {
        Args: { p_lead_id: string; p_note?: string; p_stage_id?: string }
        Returns: undefined
      }
      reorder_pipeline_stages: {
        Args: { p_open_ids: string[] }
        Returns: undefined
      }
      report_sync_status: {
        Args: { p_device_id: string; p_info: Json }
        Returns: undefined
      }
      return_lead_paper: {
        Args: { p_lead_id: string; p_paper_id: string; p_undo?: boolean }
        Returns: undefined
      }
      save_contacts_as_leads: {
        Args: { p_options?: Json; p_rows: Json }
        Returns: Json
      }
      schedule_follow_up: {
        Args: { p_due_at: string; p_lead_id: string; p_note?: string }
        Returns: string
      }
      send_sync_nudge: {
        Args: { p_message?: string; p_user_ids: string[] }
        Returns: Json
      }
      set_lead_paper: {
        Args: {
          p_copy_type?: string
          p_kept_at?: string
          p_lead_id: string
          p_note?: string
          p_paper_id: string
          p_status: string
        }
        Returns: undefined
      }
      set_paper_folder: {
        Args: { p_kept_at: string; p_lead_id: string }
        Returns: undefined
      }
      set_my_muted_notifications: { Args: { p_kinds: string[] }; Returns: undefined }
      stage_lead_counts: {
        Args: never
        Returns: {
          leads: number
          stage_id: string
        }[]
      }
      stage_of_kind: { Args: { p_kind: string }; Returns: string }
      student_ref_scope: { Args: { p_pattern: string }; Returns: string }
      sync_nudge_reason: { Args: { p_user: string }; Returns: string }
      log_template_sent: {
        Args: { p_channel: string; p_edited?: boolean; p_lead_id: string; p_template_id: string }
        Returns: string
      }
      restore_deleted: { Args: { p_activity_id: string }; Returns: undefined }
      sync_phone_calls: {
        Args: { p_calls: Json; p_device_id: string }
        Returns: Json
      }
      sync_whatsapp_events: {
        Args: { p_device_id: string; p_events: Json }
        Returns: Json
      }
      team_activity: {
        Args: { p_from: string; p_to: string }
        Returns: {
          actions: number
          admitted: number
          app_sec: number
          calls: number
          connected: number
          first_at: string | null
          last_at: string | null
          last_seen_at: string | null
          name: string | null
          role_key: string
          sessions: number
          talk_sec: number
          user_id: string
          wa_calls: number
          wa_connected: number
          wa_messages: number
          leads_added: number
          leads_imported: number
        }[]
      }
      undo_contacts_save: { Args: { p_lead_ids: string[] }; Returns: number }
      undo_import: { Args: { p_batch_id: string }; Returns: number }
      user_activity_days: {
        Args: { p_days?: number; p_user_id: string }
        Returns: { actions: number; app_sec: number; calls: number; day: string; wa: number }[]
      }
      user_activity_detail: {
        Args: { p_from: string; p_to: string; p_user_id: string }
        Returns: Json
      }
      add_negotiation_event: {
        Args: { p_negotiation_id: string; p_kind: string; p_amount?: number; p_note?: string }
        Returns: string
      }
      cancel_discount: {
        Args: { p_discount_id: string; p_note?: string }
        Returns: undefined
      }
      decide_discount: {
        Args: { p_discount_id: string; p_approve: boolean; p_note?: string }
        Returns: undefined
      }
      delete_lead_file: { Args: { p_file_id: string }; Returns: undefined }
      drive_disconnect: { Args: never; Returns: undefined }
      drive_status: { Args: never; Returns: Json }
      can_see_added: { Args: { p_user: string }; Returns: boolean }
      lead_creators: {
        Args: never
        Returns: { id: string; is_active: boolean; name: string | null }[]
      }
      link_voice_notes: { Args: { p_call_id: string; p_file_ids: string[] }; Returns: number }
      password_changed: { Args: never; Returns: undefined }
      leads_added: {
        Args: { p_from: string; p_to: string }
        Returns: { imported: number; name: string | null; total: number; user_id: string }[]
      }
      discounts_to_answer: { Args: never; Returns: number }
      discount_limit: {
        Args: { p_user?: string }
        Returns: number
      }
      discount_queue: {
        Args: never
        Returns: Json
      }
      collection_report: {
        Args: { p_from: string; p_to: string; p_user_id?: string }
        Returns: Json
      }
      record_refund: {
        Args: { p_lead_id: string; p_amount: number; p_method: string; p_reason: string; p_txn_id?: string }
        Returns: Json
      }
      record_payment: {
        Args: {
          p_lead_id: string
          p_amount: number
          p_method: string
          p_txn_id?: string
          p_paid_at?: string
          p_note?: string
        }
        Returns: Json
      }
      save_phone_call: {
        Args: {
          p_lead_id: string
          p_outcome: string
          p_notes: string
          p_duration_sec: number
          p_called_at: string
          p_direction: string
          p_device_id: string
          p_device_call_id: string
          p_sim_label?: string
        }
        Returns: string
      }
      set_installments: {
        Args: { p_lead_id: string; p_items: Json }
        Returns: undefined
      }
      void_payment: {
        Args: { p_payment_id: string; p_reason: string }
        Returns: undefined
      }
      request_discount: {
        Args: {
          p_negotiation_id: string
          p_fee_id: string | null
          p_kind: string
          p_value: number
          p_reason?: string
          p_note?: string
        }
        Returns: Json
      }
      start_negotiation: {
        Args: { p_lead_id: string; p_course_id: string }
        Returns: string
      }
      students_summary: { Args: never; Returns: Json }
      template_report: {
        Args: { p_from: string; p_to: string; p_user_id?: string }
        Returns: Json
      }
      whatsapp_report: {
        Args: { p_from: string; p_to: string; p_user_id?: string }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
