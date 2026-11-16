package rsg

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func loadTestDefinitions(t *testing.T) *LanguageDefinitions {
	t.Helper()
	return DefaultLanguageDefinitions()
}

// 🧪 [1.18.4.1] TestExtractFileAstTypeScript 多语言 AST 符号提取 (TypeScript)
func TestExtractFileAstTypeScript(t *testing.T) {
	defs := loadTestDefinitions(t)

	content := `import { helper, util as customUtil } from './helper';
import defaultService from './service';

export interface User {
  id: string;
}

export function login(name: string): void {
  console.log(name);
  helper();
}

class InternalService {
  process() {}
}

export const calculate = (a: number, b: number) => {
  return a + b;
};
`
	ast := defs.ExtractFileAst(content, "src/auth.ts")
	require.NotNil(t, ast)

	t.Run("symbols extraction", func(t *testing.T) {
		tests := []struct {
			name      string
			kind      string
			exported  bool
			startLine int
		}{
			{name: "User", kind: "type", exported: true, startLine: 4},
			{name: "login", kind: "function", exported: true, startLine: 8},
			{name: "InternalService", kind: "type", exported: false, startLine: 13},
			{name: "calculate", kind: "function", exported: true, startLine: 17},
		}

		symMap := make(map[string]SymbolEntry)
		for _, s := range ast.Symbols {
			symMap[s.Name] = s
		}

		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				sym, exists := symMap[tt.name]
				require.True(t, exists, "symbol %s should exist", tt.name)
				assert.Equal(t, tt.kind, sym.Kind)
				assert.Equal(t, tt.exported, sym.Exported)
				assert.Equal(t, tt.startLine, sym.StartLine)
				assert.GreaterOrEqual(t, sym.EndLine, sym.StartLine)
			})
		}
	})

	t.Run("named import bindings", func(t *testing.T) {
		var helperImport *ImportRecord
		for _, imp := range ast.Imports {
			if imp.Module == "./helper" {
				rec := imp
				helperImport = &rec
				break
			}
		}
		require.NotNil(t, helperImport)
		assert.Contains(t, helperImport.Bindings, "helper")
		assert.Contains(t, helperImport.Bindings, "util")
	})

	t.Run("call sites", func(t *testing.T) {
		names := make([]string, 0, len(ast.CallSites))
		for _, cs := range ast.CallSites {
			names = append(names, cs.Name)
		}
		assert.Contains(t, names, "helper")
	})
}

func TestExtractFileAstExportedConstants(t *testing.T) {
	defs := loadTestDefinitions(t)

	content := `import i18n from '@/i18n';
import { ChartType } from '.';

export const chartTypeMap = {
  [ChartType.Column]: {
    title: i18n('dashboard.chart.column'),
    icon: 'icon-bar-chart',
    type: ChartType.Column,
  },
};

export const CHART_COLORS_MAP = CHART_COLORS.reduce((acc, cur) => { 
  acc[cur.value] = cur.colors;
  return acc;
}, {});

export const AUTO_REFRESH_OPTIONS = [
  { label: 'dashboard.refresh.never', value: AUTO_REFRESH.NEVER },
];
`
	ast := defs.ExtractFileAst(content, "src/blocks/BI/Chart/constants/chartType.ts")
	require.NotNil(t, ast)

	symMap := make(map[string]SymbolEntry)
	for _, s := range ast.Symbols {
		symMap[s.Name] = s
	}

	assert.Contains(t, symMap, "chartTypeMap")
	assert.Equal(t, "type", symMap["chartTypeMap"].Kind)
	assert.True(t, symMap["chartTypeMap"].Exported)
	assert.Equal(t, 4, symMap["chartTypeMap"].StartLine)
	assert.Equal(t, 10, symMap["chartTypeMap"].EndLine)

	assert.Contains(t, symMap, "CHART_COLORS_MAP")
	assert.Equal(t, "type", symMap["CHART_COLORS_MAP"].Kind)
	assert.True(t, symMap["CHART_COLORS_MAP"].Exported)
	assert.Equal(t, 12, symMap["CHART_COLORS_MAP"].StartLine)

	assert.Contains(t, symMap, "AUTO_REFRESH_OPTIONS")
	assert.Equal(t, "type", symMap["AUTO_REFRESH_OPTIONS"].Kind)
	assert.True(t, symMap["AUTO_REFRESH_OPTIONS"].Exported)
	assert.Equal(t, 17, symMap["AUTO_REFRESH_OPTIONS"].StartLine)
}

func TestExtractFileAstJavaConstants(t *testing.T) {
	defs := loadTestDefinitions(t)

	content := `package ai.chat2db.community.web.api.config.exception;

import java.util.Map;
import com.google.common.collect.Maps;

public class EasyControllerExceptionHandler {
    public static final Map<Class<?>, IExceptionConvertor> EXCEPTION_CONVERTOR_MAP = Maps.newHashMap();

    public void handleException() {}
}
`
	ast := defs.ExtractFileAst(content, "src/EasyControllerExceptionHandler.java")
	require.NotNil(t, ast)

	symMap := make(map[string]SymbolEntry)
	for _, s := range ast.Symbols {
		symMap[s.Name] = s
	}

	assert.Contains(t, symMap, "EasyControllerExceptionHandler")
	assert.Equal(t, "type", symMap["EasyControllerExceptionHandler"].Kind)

	assert.Contains(t, symMap, "EXCEPTION_CONVERTOR_MAP")
	assert.Equal(t, "type", symMap["EXCEPTION_CONVERTOR_MAP"].Kind)
	assert.True(t, symMap["EXCEPTION_CONVERTOR_MAP"].Exported)
	assert.Equal(t, 7, symMap["EXCEPTION_CONVERTOR_MAP"].StartLine)

	assert.Contains(t, symMap, "handleException")
	assert.Equal(t, "function", symMap["handleException"].Kind)
}

func TestExtractFileAstMultilineImports(t *testing.T) {
	defs := loadTestDefinitions(t)

	content := `import {
  AuthService,
  UserRole,
} from './services/auth';
import defaultManager, {
  Config,
} from '../config';
`
	ast := defs.ExtractFileAst(content, "src/index.ts")
	require.NotNil(t, ast)
	require.Len(t, ast.Imports, 2)
	assert.Equal(t, "./services/auth", ast.Imports[0].Module)
	assert.Contains(t, ast.Imports[0].Bindings, "AuthService")
	assert.Contains(t, ast.Imports[0].Bindings, "UserRole")
	assert.Equal(t, "../config", ast.Imports[1].Module)
	assert.Contains(t, ast.Imports[1].Bindings, "defaultManager")
	assert.Contains(t, ast.Imports[1].Bindings, "Config")
}

func TestExtractFileAstPython(t *testing.T) {
	defs := loadTestDefinitions(t)

	content := `from app.models.user import UserModel, helper as h
from app.database import db

def login():
    res = run_query()
    return res

class Account:
    def deposit(self):
        pass
`
	ast := defs.ExtractFileAst(content, "app/auth.py")
	require.NotNil(t, ast)

	t.Run("python symbols", func(t *testing.T) {
		symMap := make(map[string]SymbolEntry)
		for _, s := range ast.Symbols {
			symMap[s.Name] = s
		}

		login, hasLogin := symMap["login"]
		require.True(t, hasLogin)
		assert.Equal(t, "function", login.Kind)
		assert.True(t, login.Exported)
		assert.Equal(t, 4, login.StartLine)
		assert.Equal(t, 6, login.EndLine)

		account, hasAccount := symMap["Account"]
		require.True(t, hasAccount)
		assert.Equal(t, "type", account.Kind)
		assert.True(t, account.Exported)
	})

	t.Run("python from import bindings", func(t *testing.T) {
		var userImport *ImportRecord
		for _, imp := range ast.Imports {
			if imp.Module == "app.models.user" {
				rec := imp
				userImport = &rec
				break
			}
		}
		require.NotNil(t, userImport)
		assert.Contains(t, userImport.Bindings, "UserModel")
		assert.Contains(t, userImport.Bindings, "helper")
	})

	t.Run("python call sites", func(t *testing.T) {
		foundRunQuery := false
		for _, cs := range ast.CallSites {
			if cs.Name == "run_query" {
				foundRunQuery = true
				assert.Equal(t, 5, cs.Line)
				break
			}
		}
		assert.True(t, foundRunQuery, "expected call site run_query at line 5")
	})
}

func TestExtractFileAstGo(t *testing.T) {
	defs := loadTestDefinitions(t)

	content := `package server

import "fmt"

type Server struct {
	Port int
}

type internalState struct {
	started bool
}

func Start() {
	fmt.Println("hi")
}

func (s *Server) Handle() {
	Start()
}
`
	ast := defs.ExtractFileAst(content, "cmd/server/main.go")
	require.NotNil(t, ast)

	t.Run("go symbols capitalized export convention", func(t *testing.T) {
		symMap := make(map[string]SymbolEntry)
		for _, s := range ast.Symbols {
			symMap[s.Name] = s
		}

		server, hasServer := symMap["Server"]
		require.True(t, hasServer)
		assert.Equal(t, "type", server.Kind)
		assert.True(t, server.Exported, "Server starts with uppercase -> exported")

		internal, hasInternal := symMap["internalState"]
		require.True(t, hasInternal)
		assert.Equal(t, "type", internal.Kind)
		assert.False(t, internal.Exported, "internalState starts with lowercase -> unexported")

		start, hasStart := symMap["Start"]
		require.True(t, hasStart)
		assert.Equal(t, "function", start.Kind)
		assert.True(t, start.Exported)

		handle, hasHandle := symMap["Handle"]
		require.True(t, hasHandle)
		assert.Equal(t, "function", handle.Kind)
		assert.True(t, handle.Exported)
	})
}

func TestExtractFileAstRust(t *testing.T) {
	defs := loadTestDefinitions(t)

	content := `pub struct Config {
    pub port: u16,
}

struct InternalData {
    secret: String,
}

pub fn run() {
    init();
}

fn init() {}
`
	ast := defs.ExtractFileAst(content, "src/lib.rs")
	require.NotNil(t, ast)

	t.Run("rust visibility modifier export convention", func(t *testing.T) {
		symMap := make(map[string]SymbolEntry)
		for _, s := range ast.Symbols {
			symMap[s.Name] = s
		}

		cfg, hasCfg := symMap["Config"]
		require.True(t, hasCfg)
		assert.Equal(t, "type", cfg.Kind)
		assert.True(t, cfg.Exported, "pub struct -> exported")

		internal, hasInternal := symMap["InternalData"]
		require.True(t, hasInternal)
		assert.False(t, internal.Exported, "struct without pub -> unexported")

		run, hasRun := symMap["run"]
		require.True(t, hasRun)
		assert.Equal(t, "function", run.Kind)
		assert.True(t, run.Exported)

		initFn, hasInit := symMap["init"]
		require.True(t, hasInit)
		assert.False(t, initFn.Exported)
	})
}
